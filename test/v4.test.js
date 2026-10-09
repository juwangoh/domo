'use strict';
// v4: 이미지·파일 첨부, 답장(인용), 실시간 진행 이벤트, 내 차례 푸시 알림.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { mockLog } = require('../src/engines');
const { decrypt } = require('../src/push');

const PASSWORD = 'v4-pass';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-v4-'));
const pushed = [];
let app;
let cookie;

async function api(method, p, body) {
  const res = await fetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie || '' }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type, setCookie: res.headers.get('set-cookie') };
}
async function waitFor(fn, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('시간 초과');
}
const idle = (roomId) => waitFor(async () => {
  const d = (await api('GET', `/api/rooms/${roomId}/messages`)).data;
  return !d.running && d.messages.at(-1)?.sender !== 'user' ? d.messages : null;
});

test.before(async () => {
  app = createApp({ configPath: require('node:path').join(__dirname, 'fixtures', 'agents.legacy.json'),
    dataDir, password: PASSWORD, agentOverrides: { engine: 'mock', mockDelayMs: 10 }, enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws'),
    pushFetch: async (url, opts) => { pushed.push({ url, opts }); return { ok: true, status: 201 }; },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  cookie = (await api('POST', '/api/login', { password: PASSWORD })).setCookie.split(';')[0];
  await api('PATCH', '/api/settings', { autoMemory: false });
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('첨부: 이미지를 올리면 작업 폴더에 저장되고, 메시지에 붙어 AI가 경로를 받고, 로그인한 사람만 볼 수 있다', async () => {
  const up = await api('POST', '/api/rooms/dm-claude/upload', { name: '로고 초안.png', type: 'image/png', data: PNG });
  assert.equal(up.status, 201);
  const f = up.data.file;
  assert.ok(fs.existsSync(f.path));
  assert.equal(f.image, true);
  assert.equal((await api('POST', '/api/rooms/dm-claude/upload', { name: 'x.exe', type: 'application/x-msdownload', data: 'AAAA' })).status, 400);

  mockLog.length = 0;
  await api('POST', '/api/rooms/dm-claude/messages', { text: '이 로고 어때?', files: [f.id] });
  const msgs = await idle('dm-claude');
  const mine = msgs.findLast((m) => m.sender === 'user');
  assert.equal(mine.meta.files[0].name, '로고 초안.png');
  const call = mockLog.find((c) => c.agentId === 'claude');
  assert.ok(call.prompt.includes(f.path), 'AI 프롬프트에 파일 경로가 들어간다');
  assert.deepEqual(call.images, [f.path], 'Codex 용 이미지 목록에도 들어간다');

  const img = await api('GET', f.url);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/png');
  const saved = cookie;
  cookie = '';
  assert.equal((await api('GET', f.url)).status, 401);
  cookie = saved;
  // 첨부만 보내도 된다
  assert.equal((await api('POST', '/api/rooms/dm-claude/messages', { text: '', files: [f.id] })).status, 201);
  await idle('dm-claude');
});

test('답장: 인용한 메시지가 저장되고, AI는 본문 뒤에 붙은 인용을 받는다 (명령 인식은 그대로)', async () => {
  const last = (await api('GET', '/api/rooms/dm-claude/messages')).data.messages.findLast((m) => m.sender === 'claude');
  mockLog.length = 0;
  await api('POST', '/api/rooms/dm-claude/messages', { text: '이 부분만 짧게', replyTo: last.id });
  const msgs = await idle('dm-claude');
  const mine = msgs.findLast((m) => m.sender === 'user');
  assert.equal(mine.meta.reply.id, last.id);
  assert.equal(mine.text, '이 부분만 짧게');
  const prompt = mockLog.find((c) => c.agentId === 'claude').prompt;
  assert.match(prompt, /이 부분만 짧게\n\(↪ 클로드의 ".+"에 대한 답\)/);
});

test('실시간 진행: 엔진이 도구를 쓰면 activity 이벤트로 지금 하는 일이 전달된다', async () => {
  const events = [];
  const on = (e) => events.push(e);
  app.orch.bus.on('activity', on);
  await api('POST', '/api/rooms/dm-claude/messages', { text: '찾아봐줘' });
  await idle('dm-claude');
  app.orch.bus.off('activity', on);
  assert.ok(events.some((e) => e.roomId === 'dm-claude' && e.agentId === 'claude' && e.label === '웹 검색 · mock'));
});

test('푸시: 구독하면 내 차례·1:1 답장 때 암호화된 알림을 보내고, 수신 기기에서 풀 수 있다', async () => {
  const key = (await api('GET', '/api/push/key')).data.publicKey;
  assert.equal(Buffer.from(key, 'base64url').length, 65);
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  const subscription = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth } };
  assert.equal((await api('POST', '/api/push/subscribe', { subscription })).data.count, 1);

  pushed.length = 0;
  await api('POST', '/api/rooms/dm-claude/messages', { text: '안녕' });
  await idle('dm-claude');
  await waitFor(() => pushed.length);
  const { url, opts } = pushed[0];
  assert.equal(url, subscription.endpoint);
  assert.equal(opts.headers['Content-Encoding'], 'aes128gcm');
  assert.match(opts.headers.Authorization, /^vapid t=.+, k=/);
  const note = JSON.parse(decrypt(opts.body, ua, auth).toString());
  assert.equal(note.title, '클로드');
  assert.equal(note.url, '/#/r/dm-claude');

  const t = await api('POST', '/api/push/test');
  assert.equal(t.data.sent, 1);
});
