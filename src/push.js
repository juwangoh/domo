'use strict';
// 웹 푸시 (외부 라이브러리 없음): VAPID 서명(RFC 8292) + aes128gcm 암호화(RFC 8291/8188).
// 스튜디오 컨펌처럼 "내 차례"가 오면 폰 홈 화면 앱으로 알림을 보낸다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

class Push {
  constructor(dataDir, { subject = 'mailto:domo@localhost', fetchImpl = globalThis.fetch } = {}) {
    this.file = path.join(dataDir, 'push.json');
    this.subject = subject;
    this.fetch = fetchImpl;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = null; }
    if (!this.data?.privateJwk) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.data = { publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)), privateJwk: privateKey.export({ format: 'jwk' }), subs: [] };
      this.save();
    }
    this.data.subs ||= [];
  }

  save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), { mode: 0o600 }); }
  get publicKey() { return this.data.publicKey; }

  subscribe(sub) {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error('잘못된 구독 정보'), { status: 400 });
    if (!/^https:\/\//.test(sub.endpoint)) throw Object.assign(new Error('잘못된 구독 주소'), { status: 400 });
    this.data.subs = this.data.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.data.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: Date.now() });
    this.save();
  }

  unsubscribe(endpoint) {
    this.data.subs = this.data.subs.filter((s) => s.endpoint !== endpoint);
    this.save();
  }

  vapidHeader(endpoint) {
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.subject }));
    const key = crypto.createPrivateKey({ key: this.data.privateJwk, format: 'jwk' });
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${this.publicKey}`;
  }

  async sendAll(payload) {
    const results = await Promise.all(this.data.subs.map((s) => this.send(s, payload).catch((err) => ({ ok: false, error: err.message }))));
    const gone = this.data.subs.filter((s, i) => [404, 410].includes(results[i]?.status));
    if (gone.length) { for (const g of gone) this.unsubscribe(g.endpoint); }
    return results;
  }

  async send(sub, payload) {
    const body = encrypt(sub, Buffer.from(JSON.stringify(payload)));
    const res = await this.fetch(sub.endpoint, {
      method: 'POST',
      headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: this.vapidHeader(sub.endpoint) },
      body,
    });
    return { ok: res.ok, status: res.status };
  }
}

// RFC 8291: 구독자의 공개키(p256dh)와 auth 비밀로 메시지를 암호화한다.
function encrypt(sub, plaintext, { salt = crypto.randomBytes(16) } = {}) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const uaPublic = fromB64u(sub.keys.p256dh);
  const auth = fromB64u(sub.keys.auth);
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

// 테스트용: 브라우저(수신자) 쪽 복호화
function decrypt(body, uaEcdh, authB64) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = uaEcdh.getPublicKey();
  const shared = uaEcdh.computeSecret(asPublic);
  const prkKey = hmac(fromB64u(authB64), shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return pt.subarray(0, pt.lastIndexOf(2));
}

module.exports = { Push, encrypt, decrypt };
