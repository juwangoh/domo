'use strict';
// v1.3.1 기준: 팀 작업의 단계 진행 알림 · 리서치는 새로운 자료 우선 · 발상은 뻔한 안을 피한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domo-v10-'));
const calls = [];
const fakeEngine = (engine) => async ({ prompt, agent }) => {
  calls.push({ engine, agentId: agent.id, prompt, system: agent.systemPrompt || '' });
  return { text: /JSON/.test(agent.systemPrompt || '') ? '{}' : `${agent.name}의 답`, sessionId: null, meta: {} };
};
const fake = { claude: { installed: true, loggedIn: true }, codex: { installed: false, loggedIn: false } };
let app;
let cookie;

async function api(method, p, body) {
  const res = await fetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), setCookie: res.headers.get('set-cookie') };
}
async function idle(id) {
  for (let i = 0; i < 500; i++) {
    const d = (await api('GET', `/api/rooms/${id}/messages`)).data;
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
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
});

test('리서치: 단계 진행을 알리고, 끝나면 진행 표시를 지운다', async () => {
  const events = [];
  const on = (p) => events.push(p);
  app.orch.bus.on('progress', on);
  const room = (await api('POST', '/api/rooms', { members: ['claude'] })).data.room;
  await api('POST', `/api/rooms/${room.id}/messages`, { text: '/리서치 폐교 활용 공공 공간 사례' });
  await idle(room.id);
  app.orch.bus.off('progress', on);
  const steps = events.filter((e) => !e.done);
  assert.deepEqual(steps.map((e) => e.current), ['facts', 'wrap'], 'Codex 미연결이면 교차 검증 단계가 없다');
  assert.deepEqual(steps[0].steps.map((s) => s.key), ['facts', 'wrap']);
  assert.ok(steps.every((e) => e.team === 'research' && e.since && e.hint));
  assert.ok(events.at(-1).done, '끝나면 지운다');
  const listed = (await api('GET', '/api/rooms')).data.rooms.find((r) => r.id === room.id);
  assert.equal(listed.progress, null);
});

test('리서치 지시서: 널리 알려진 내용보다 최근·1차·통념과 다른 자료를 우선한다', () => {
  const facts = calls.find((c) => c.prompt.startsWith('[팀 서비스: 데스크리서치]')).prompt;
  assert.match(facts, /## 조사 깊이 \(새로운 자료 우선\)/);
  assert.match(facts, /\| # \| 사실 \| 새로움\(최신·깊음·반전·배경\) \|/);
  assert.match(facts, /## 의외였던 것/);
  const wrap = calls.find((c) => c.prompt.includes('[팀 서비스: 데스크리서치 · 정리]')).prompt;
  assert.match(wrap, /새로 알게 된 것을 앞에/);
  const studio = require('../src/studio');
  assert.match(studio.prompts.facts({ request: '폐교 활용', docs: {} }), /조사 깊이/);
});

test('발상: 컨셉 방향안과 팀 초안, 일반 대화에 뻔한 안을 피하는 규칙이 들어간다', async () => {
  const studio = require('../src/studio');
  const team = require('../src/team');
  const dir = studio.prompts.directions({ request: '폐교 활용', docs: {} });
  assert.match(dir, /## 발상 규칙/);
  assert.match(dir, /출발한 발견:/);
  assert.match(dir, /이 안이 그것과 다른 점/);
  const verify = studio.prompts.verify({ request: '데님', docs: { answers: '1. 오래 입을수록 가치가 생긴다' } });
  assert.match(verify, /사용자 답변[\s\S]*오래 입을수록/, '검증 담당도 사용자 답변을 본다');
  assert.match(team.prompts.draft({ request: '졸업전시 주제 3개' }), /뻔한 AI 아이디어 피하기/);
  const room = (await api('POST', '/api/rooms', { members: ['claude'] })).data.room;
  await api('POST', `/api/rooms/${room.id}/messages`, { text: '전시 아이디어 하나만 줘' });
  await idle(room.id);
  assert.match(calls.at(-1).system, /\[발상 규칙\]/);
});
