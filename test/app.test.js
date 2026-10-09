'use strict';
// 성공 기준 2·3·4·7·8·9 를 mock 엔진으로 검증한다 (요금·네트워크 없음, 자식 프로세스는 실제로 뜸).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/app');
const { mockLog } = require('../src/engines');

const PASSWORD = 'test-pass-1234';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-test-'));
const overrides = { engine: 'mock', mockDelayMs: 20 };

async function start() {
  const app = createApp({ configPath: require('node:path').join(__dirname, 'fixtures', 'agents.legacy.json'), dataDir, password: PASSWORD, agentOverrides: overrides, enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws') });
  app.profiles.updateSettings({ autoMemory: false }); // 이 파일은 대화 흐름만 검증 (기억은 v2 테스트)
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  return app;
}
async function stop(app) {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
}

async function api(app, method, p, body, cookie) {
  const res = await fetch(app.base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}

async function waitIdle(app, cookie, roomId, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const { data } = await api(app, 'GET', `/api/rooms/${roomId}/messages`, null, cookie);
    const last = data.messages.at(-1);
    if (!data.running && last && last.sender !== 'user') return data.messages;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('시간 초과: 대화가 끝나지 않음');
}

let app;
let cookie;

test.before(async () => {
  app = await start();
  const r = await api(app, 'POST', '/api/login', { password: PASSWORD });
  cookie = r.setCookie.split(';')[0];
});
test.after(async () => { if (app) await stop(app); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('기준7: 로그인 없이는 API 접근 불가, 틀린 비밀번호 거부', async () => {
  assert.equal((await api(app, 'GET', '/api/rooms')).status, 401);
  assert.equal((await api(app, 'POST', '/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await api(app, 'GET', '/api/rooms', null, cookie)).status, 200);
});

test('기본 대화방 4개가 만들어진다 (회의실 포함)', async () => {
  const { data } = await api(app, 'GET', '/api/rooms', null, cookie);
  assert.deepEqual(data.rooms.map((r) => r.id).sort(), ['dm-claude', 'dm-codex', 'group', 'meeting']);
  assert.equal(data.rooms.find((r) => r.id === 'meeting').mode, 'meeting');
});

test('기준2·3: 작업→감사(수정필요)→수정→감사(통과) 후 자동 종료, 서로의 말을 본다', async () => {
  mockLog.length = 0;
  await api(app, 'POST', '/api/rooms/group/messages', { text: '크레아틴 제품 추천해줘' }, cookie);
  const msgs = await waitIdle(app, cookie, 'group');
  const flow = msgs.map((m) => m.sender + (m.meta?.verdict ? `:${m.meta.verdict}` : ''));
  assert.deepEqual(flow, ['user', 'claude', 'codex:revise', 'claude', 'codex:pass', 'system']);
  assert.equal(msgs.at(-1).meta.kind, 'pass');
  // 판정 줄은 말풍선 본문에서 제거된다
  assert.ok(!msgs[2].text.includes('판정'));

  const [w1, r1, w2, r2] = mockLog;
  assert.equal(w1.agentId, 'claude');
  assert.match(w1.prompt, /크레아틴 제품 추천해줘/);
  assert.equal(r1.agentId, 'codex');
  assert.ok(r1.prompt.includes(msgs[1].text), '감사 AI가 작업 AI의 답변을 받아야 함');
  assert.ok(r1.prompt.includes('크레아틴'), '감사 AI는 사람의 원래 요청도 받아야 함');
  assert.ok(w2.prompt.includes(msgs[2].text), '작업 AI가 감사 지적을 받아야 함');
  assert.ok(!w2.prompt.includes(msgs[1].text), '자기 이전 발언은 다시 보내지 않음(세션이 기억)');
  assert.equal(w1.sessionId, null, '첫 차례는 새 세션');
  assert.ok(w2.sessionId, '두 번째 차례부터는 세션을 이어감(resume)');
  assert.equal(r1.sessionId, null);
  assert.ok(r2.sessionId);
});

test('기준2: 통과가 안 나와도 최대 라운드에서 반드시 멈춘다', async () => {
  const { data } = await api(app, 'POST', '/api/rooms', { name: '엄격', members: ['claude', 'codex'], maxRounds: 2 }, cookie);
  await api(app, 'POST', `/api/rooms/${data.room.id}/messages`, { text: '이건 #never-pass' }, cookie);
  const msgs = await waitIdle(app, cookie, data.room.id);
  assert.equal(msgs.filter((m) => m.sender === 'claude').length, 2);
  assert.equal(msgs.filter((m) => m.sender === 'codex').length, 2);
  assert.equal(msgs.at(-1).meta.kind, 'limit');
});

test('기준8: 감사 AI가 실패해도 서버는 살아 있고 오류 말풍선이 뜬다', async () => {
  const { data } = await api(app, 'POST', '/api/rooms', { members: ['claude', 'codex'] }, cookie);
  await api(app, 'POST', `/api/rooms/${data.room.id}/messages`, { text: '실패 테스트 #fail' }, cookie);
  const msgs = await waitIdle(app, cookie, data.room.id);
  const err = msgs.at(-1);
  assert.equal(err.sender, 'system');
  assert.equal(err.meta.kind, 'error');
  assert.match(err.text, /코덱스 응답 실패/);
  assert.equal((await api(app, 'GET', '/api/health')).status, 200);
  // 실패 뒤에도 같은 방에서 계속 대화 가능
  await api(app, 'POST', `/api/rooms/${data.room.id}/messages`, { text: '@클로드 다시 해볼까?' }, cookie);
  const after = await waitIdle(app, cookie, data.room.id);
  assert.equal(after.at(-1).sender, 'claude');
});

test('@멘션하면 그 AI만 답한다', async () => {
  const before = (await api(app, 'GET', '/api/rooms/group/messages', null, cookie)).data.messages.length;
  await api(app, 'POST', '/api/rooms/group/messages', { text: '@코덱스 너 혼자 대답해봐' }, cookie);
  const msgs = (await waitIdle(app, cookie, 'group')).slice(before);
  assert.deepEqual(msgs.map((m) => m.sender), ['user', 'codex']);
});

test('기준7: 중단 버튼이 실행 중인 AI 프로세스를 실제로 종료한다', async () => {
  const { data } = await api(app, 'POST', '/api/rooms', { members: ['claude'] }, cookie);
  const id = data.room.id;
  await api(app, 'POST', `/api/rooms/${id}/messages`, { text: '오래 걸리는 일 #slow' }, cookie);
  let pids = [];
  for (let i = 0; i < 100 && !pids.length; i++) {
    pids = [...(app.orch.running.get(id)?.children || [])];
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(pids.length, 'AI 프로세스가 떠 있어야 함');
  assert.doesNotThrow(() => process.kill(pids[0], 0));
  assert.equal((await api(app, 'POST', `/api/rooms/${id}/stop`, null, cookie)).data.stopped, true);
  const msgs = await waitIdle(app, cookie, id);
  assert.equal(msgs.at(-1).meta.kind, 'stopped');
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pids[0], 0), /ESRCH/, '프로세스가 종료되어야 함');
});

test('실시간 이벤트(SSE)로 입력 중·메시지가 전달된다', async () => {
  const events = [];
  const req = http.get(`${app.base}/api/events`, { headers: { Cookie: cookie } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(block)?.[1];
        if (ev) events.push(ev);
      }
    });
  });
  await new Promise((r) => setTimeout(r, 100));
  await api(app, 'POST', '/api/rooms/dm-claude/messages', { text: '안녕' }, cookie);
  await waitIdle(app, cookie, 'dm-claude');
  await new Promise((r) => setTimeout(r, 100));
  req.destroy();
  for (const ev of ['message', 'typing', 'status']) assert.ok(events.includes(ev), `${ev} 이벤트 누락`);
});

test('기준4: 서버를 재시작해도 기록과 AI 세션이 유지되고 이어서 대화한다', async () => {
  const before = (await api(app, 'GET', '/api/rooms/group/messages', null, cookie)).data.messages;
  const sessionBefore = app.store.getRoom('group').agentState.claude.sessionId;
  await stop(app);
  app = await start();
  // 로그인 토큰도 유지된다
  const after = (await api(app, 'GET', '/api/rooms/group/messages', null, cookie)).data.messages;
  assert.deepEqual(after, before);
  assert.equal(app.store.getRoom('group').agentState.claude.sessionId, sessionBefore);
  mockLog.length = 0;
  await api(app, 'POST', '/api/rooms/group/messages', { text: '@클로드 아까 얘기 이어서' }, cookie);
  await waitIdle(app, cookie, 'group');
  assert.equal(mockLog[0].sessionId, sessionBefore, '재시작 후에도 같은 세션으로 resume');
});

test('AI 기억 초기화 후에는 새 세션으로 시작한다', async () => {
  await api(app, 'POST', '/api/rooms/group/reset', null, cookie);
  mockLog.length = 0;
  await api(app, 'POST', '/api/rooms/group/messages', { text: '@클로드 처음부터' }, cookie);
  await waitIdle(app, cookie, 'group');
  assert.equal(mockLog[0].sessionId, null);
});
