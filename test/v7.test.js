'use strict';
// v1.2.1 기준: Codex 미연결이면 검증 생략을 결과물에 찍는다 · 리서치 지시서에 사용자 상황이 들어간다 · 시작 전에 예상 호출 수를 알려 준다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domo-v7-'));
const calls = [];
// 실제 CLI 대신 기록만 하는 엔진. Codex 는 연결되지 않았으므로 불리면 안 된다.
const fakeEngine = (engine) => async ({ prompt, agent }) => {
  calls.push({ engine, agentId: agent.id, prompt });
  return { text: engine === 'claude' && /JSON/.test(agent.systemPrompt || '') ? '{}' : `${agent.name}의 답\n판정: 통과`, sessionId: null, meta: {} };
};
const fake = { claude: { installed: true, loggedIn: true }, codex: { installed: false, loggedIn: false } };
let app;
let cookie;

async function api(method, p, body) {
  const res = await fetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), setCookie: res.headers.get('set-cookie') };
}
const messages = async (id) => (await api('GET', `/api/rooms/${id}/messages`)).data;
async function idle(id) {
  for (let i = 0; i < 500; i++) {
    const d = await messages(id);
    if (!d.running && d.messages.at(-1)?.sender !== 'user') return d.messages;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('시간 초과');
}

test.before(async () => {
  app = createApp({
    dataDir, engines: { claude: fakeEngine('claude'), codex: fakeEngine('codex') }, enableScheduler: false, enableTunnel: false,
    workspace: path.join(dataDir, 'ws'), connections: { fake },
  });
  app.profiles.updateSettings({ autoMemory: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  const ok = await api('POST', '/api/signup', { name: '테스트', email: 't@example.com', password: 'longpassword' });
  cookie = ok.setCookie.split(';')[0];
  await api('POST', '/api/onboarding', { answers: { job: '대학생', field: '트랜스아트', work: '대구 수성미디어아트페스타 공모전 준비', tasks: ['research'], tone: 'direct', goal: '중간고사 전 출품' } });
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
});

test('예상 호출 수: Codex 미연결이면 리서치는 1회이고 검증 생략을 미리 알린다', async () => {
  const { plan } = (await api('GET', '/api/me')).data.team;
  assert.equal(plan.research.calls, 1);
  assert.match(plan.research.note, /교차 검증 생략 \(Codex 미연결\)/);
  assert.equal(plan.critique.calls, 4);
  assert.ok(plan.concept.approx && plan.concept.calls >= 7);
  assert.ok(plan.critique.models.length >= 1);
});

test('/리서치: Codex 미연결이면 검증한다고 말하지 않고, 결과물에 검증 생략을 찍고, 사용자 상황을 지시서에 넣는다', async () => {
  const room = (await api('POST', '/api/rooms', { members: [app.profiles.settings.primaryAgent] })).data.room;
  calls.length = 0;
  await api('POST', `/api/rooms/${room.id}/messages`, { text: '/리서치 미디어아트 공모전 동향' });
  const msgs = await idle(room.id);
  const stage = msgs.find((m) => m.meta?.kind === 'stage');
  assert.match(stage.text, /교차 검증은 생략됩니다 \(Codex 미연결\)/);
  assert.doesNotMatch(stage.text, /가 교차 검증합니다/);
  const sheet = msgs.find((m) => m.meta?.team === 'research' && m.sender !== 'system' && m.meta.label);
  assert.match(sheet.meta.label, /검증 생략됨\(Codex 미연결\)/);
  assert.ok(msgs.some((m) => m.sender === 'system' && /교차 검증 생략됨/.test(m.text)));
  assert.ok(!msgs.some((m) => m.meta?.kind === 'error'), '연결 안 된 AI 를 불러 오류를 내지 않는다');
  assert.ok(calls.every((c) => c.engine === 'claude'));
  const brief = calls.find((c) => c.prompt.includes('데스크리서치')).prompt;
  assert.match(brief, /## 사용자 상황[\s\S]*수성미디어아트페스타/);

  // /검증 도 같은 회사 모델이 대신했음을 밝힌다
  const before = msgs.length;
  await api('POST', `/api/rooms/${room.id}/messages`, { text: '/검증' });
  const after = (await idle(room.id)).slice(before);
  assert.match(after.find((m) => m.meta?.team === 'verify' && m.meta.label).meta.label, /같은 회사 모델/);
});

test('Codex 를 연결하면 다시 교차 검증한다', async () => {
  fake.codex = { installed: true, loggedIn: true };
  assert.equal((await api('GET', '/api/me')).data.team.plan.research.calls, 2);
  const room = (await api('POST', '/api/rooms', { members: [app.profiles.settings.primaryAgent] })).data.room;
  await api('POST', `/api/rooms/${room.id}/messages`, { text: '/리서치 미디어아트 공모전 동향' });
  const msgs = await idle(room.id);
  assert.deepEqual(msgs.filter((m) => m.meta?.team === 'research' && m.sender !== 'system').map((m) => m.meta.label), ['팩트시트', '교차 검증']);
});
