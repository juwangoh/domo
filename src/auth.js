'use strict';
// 이 DOMO 인스턴스의 주인 계정 1개 + 로그인 토큰(쿠키).
// GitHub 배포형: 각자 자기 Mac·Codespace 에서 DOMO 를 띄우고, 처음 접속한 화면에서 회원가입(주인 계정 만들기)을 한다.
// 다른 컴퓨터에서 처음 가입하려면 서버 터미널에 찍힌 설정 코드가 필요하다 (같은 Wi‑Fi 의 다른 사람이 먼저 가입하는 것을 막기 위해).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Auth {
  constructor(dataDir, envPassword) {
    this.file = path.join(dataDir, 'auth.json');
    this.data = this.#load();
    this.failures = new Map(); // ip → [timestamps]
    this.generatedPassword = null; // (구버전 호환) 이제 비밀번호는 회원가입 화면에서 만든다
    if (envPassword && !this.check(envPassword)) this.setPassword(envPassword);
    this.setupCode = this.hasAccount ? null : String(crypto.randomInt(100000, 1000000));
  }

  #load() {
    try { return { tokens: [], account: null, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { return { tokens: [], account: null }; }
  }

  #save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  get hasAccount() { return !!this.data.hash; }
  get account() {
    return { name: this.data.account?.name || '', email: this.data.account?.email || '', createdAt: this.data.account?.createdAt || null };
  }

  // 회원가입: 계정이 없을 때 한 번만. 로컬 접속이 아니면 설정 코드가 필요하다.
  signup({ name, email, password, setupCode }, { local = false } = {}) {
    if (this.hasAccount) return { error: '이미 계정이 있습니다. 로그인하세요.', status: 409 };
    if (!local && String(setupCode || '').trim() !== this.setupCode) return { error: '설정 코드가 올바르지 않습니다. 서버를 실행한 터미널에 표시된 6자리 코드를 입력하세요.', status: 403 };
    const n = String(name || '').trim().slice(0, 30);
    const e = String(email || '').trim().toLowerCase().slice(0, 120);
    if (!n) return { error: '이름을 입력하세요.', status: 400 };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: '이메일 형식이 올바르지 않습니다.', status: 400 };
    if (String(password || '').length < 8) return { error: '비밀번호는 8자 이상이어야 합니다.', status: 400 };
    this.data.account = { name: n, email: e, createdAt: Date.now() };
    this.setPassword(password);
    this.setupCode = null;
    return this.issue();
  }

  setPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    this.data.salt = salt;
    this.data.hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    this.data.tokens = []; // 비밀번호가 바뀌면 모든 기기 로그아웃
    this.#save();
  }

  check(pw) {
    if (!this.data.hash) return false;
    const h = crypto.scryptSync(String(pw), this.data.salt, 32);
    return crypto.timingSafeEqual(h, Buffer.from(this.data.hash, 'hex'));
  }

  // IP당 1분에 8회, 전체 10분에 40회 실패하면 잠근다 (외부 주소로 열려 있을 때 무차별 대입 방지).
  rateLimited(ip) {
    const now = Date.now();
    const recent = (this.failures.get(ip) || []).filter((t) => now - t < 60_000);
    this.failures.set(ip, recent);
    this.globalFailures = (this.globalFailures || []).filter((t) => now - t < 600_000);
    return recent.length >= 8 || this.globalFailures.length >= 40;
  }

  // 이메일이 등록된 계정이면 이메일도 맞아야 한다. (이메일 없이 만든 구버전 계정은 비밀번호만)
  login(pw, ip, email) {
    if (!this.hasAccount) return { error: '아직 계정이 없습니다. 회원가입을 먼저 하세요.' };
    if (this.rateLimited(ip)) return { error: '시도가 너무 많습니다. 1분 뒤 다시 시도하세요.' };
    const wantEmail = this.data.account?.email;
    const emailOk = !wantEmail || !email || String(email).trim().toLowerCase() === wantEmail;
    if (!emailOk || !this.check(pw)) {
      this.failures.get(ip).push(Date.now());
      this.globalFailures.push(Date.now());
      return { error: '이메일 또는 비밀번호가 올바르지 않습니다.' };
    }
    return this.issue();
  }

  issue() {
    const token = crypto.randomBytes(32).toString('hex');
    this.data.tokens.push(sha(token));
    this.data.tokens = this.data.tokens.slice(-50);
    this.#save();
    return { token };
  }

  updateAccount({ name, email }) {
    this.data.account ||= { name: '', email: '', createdAt: Date.now() };
    if (typeof name === 'string' && name.trim()) this.data.account.name = name.trim().slice(0, 30);
    if (typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) this.data.account.email = email.trim().toLowerCase();
    this.#save();
    return this.account;
  }

  logout(token) {
    this.data.tokens = this.data.tokens.filter((t) => t !== sha(token));
    this.#save();
  }

  valid(token) {
    return !!token && this.data.tokens.includes(sha(token));
  }
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

module.exports = { Auth };
