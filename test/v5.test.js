'use strict';
// v5 기준: 회원가입(설정 코드) · 로그인 · AI 연결 상태 · 온보딩 맞춤 페르소나 · 기본 1명 + 팀 서비스 · 블라인드 비교.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { mockLog } = require('../src/engines');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-v5-'));
let app;
let cookie;

async function api(method, p, body, { c = cookie, headers = {} } = {}) {
  const res = await fetch(app.base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(c ? { Cookie: c } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json(), setCookie: res.headers.get('set-cookie') };
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
const messages = async (id) => (await api('GET', `/api/rooms/${id}/messages`)).data;
const idle = (id) => waitFor(async () => {
  const d = await messages(id);
  return !d.running && d.messages.at(-1)?.sender !== 'user' ? d.messages : null;
});

test.before(async () => {
  app = createApp({
    dataDir, agentOverrides: { engine: 'mock', mockDelayMs: 10 }, enableScheduler: false, enableTunnel: false,
    workspace: path.join(dataDir, 'ws'),
    connections: { fake: { claude: { installed: true, loggedIn: true, method: 'claude.ai', plan: 'pro' }, codex: { installed: true, loggedIn: false } } },
  });
  app.profiles.updateSettings({ autoMemory: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('회원가입: 계정이 없으면 가입 화면, 원격 가입은 설정 코드 필요, 가입은 한 번만', async () => {
  assert.deepEqual((await api('GET', '/api/setup', null, { c: null })).data.hasAccount, false);
  const remote = { 'x-forwarded-for': '203.0.113.5' };
  assert.equal((await api('GET', '/api/setup', null, { c: null, headers: remote })).data.needsCode, true);
  const form = { name: '테스트', email: 'Test@Example.com', password: 'longpassword' };
  assert.equal((await api('POST', '/api/signup', form, { c: null, headers: remote })).status, 403, '코드 없이 원격 가입 불가');
  assert.equal((await api('POST', '/api/signup', { ...form, setupCode: '000000' }, { c: null, headers: remote })).status, 403);
  assert.equal((await api('POST', '/api/signup', { ...form, password: 'short' }, { c: null })).status, 400);
  const ok = await api('POST', '/api/signup', { ...form, setupCode: app.auth.setupCode }, { c: null, headers: remote });
  assert.equal(ok.status, 201);
  cookie = ok.setCookie.split(';')[0];
  assert.equal((await api('POST', '/api/signup', form, { c: null })).status, 409, '두 번째 가입 불가');
  assert.equal((await api('POST', '/api/login', { email: 'other@example.com', password: 'longpassword' }, { c: null })).status, 401);
  assert.equal((await api('POST', '/api/login', { email: 'test@example.com', password: 'longpassword' }, { c: null })).status, 200);
  const me = (await api('GET', '/api/me')).data;
  assert.equal(me.account.email, 'test@example.com');
  assert.equal(me.user.name, '테스트');
  assert.ok(!me.settings.onboarded);
});

test('AI 연결 상태: 이 컴퓨터의 Claude·Codex 로그인 여부를 보여준다', async () => {
  const { connections } = (await api('GET', '/api/connections')).data;
  assert.equal(connections.claude.loggedIn, true);
  assert.equal(connections.codex.loggedIn, false);
});

test('온보딩: 직업·하는 일·관심사·톤으로 팀 페르소나 6역할을 맞춤화하고 첫 작업 3개를 추천', async () => {
  const answers = { job: '대학생', field: '산업디자인 3학년', work: '졸업전시 준비', interests: '가구, 지속가능 소재', hobbies: '빈티지 수집', tasks: ['critique', 'research', 'concept'], tone: 'direct', goal: '11월 졸업전시' };
  const r = (await api('POST', '/api/onboarding', { answers })).data;
  assert.equal(r.suggestions.length, 3);
  assert.ok(r.suggestions.some((s) => s.prompt.startsWith('/크리틱')));
  const roles = r.agents.map((a) => a.studioRole).filter(Boolean).sort();
  assert.deepEqual(roles, ['concept', 'critic', 'pm', 'producer', 'research', 'verifier']);
  const critic = r.agents.find((a) => a.studioRole === 'critic');
  assert.match(critic.soul, /산업디자인 3학년/);
  assert.match(critic.soul, /직설적으로/);
  assert.equal(critic.personality, 'critic');
  assert.ok(!r.agents.some((a) => /juwang/.test(a.soul)), '개인 스킬 이름이 들어가지 않음');
  const me = (await api('GET', '/api/me')).data;
  assert.equal(me.settings.onboarded, true);
  assert.equal(me.agents.find((a) => a.id === me.settings.primaryAgent).studioRole, 'producer');
  const { memory } = (await api('GET', '/api/memory')).data;
  assert.ok(memory.user.some((u) => u.text.includes('가구')));
});

let chatId;
test('기본은 AI 1명: 새 채팅은 한 AI만 답하고, 첫 메시지로 제목이 정해진다', async () => {
  const me = (await api('GET', '/api/me')).data;
  chatId = (await api('POST', '/api/rooms', { name: '새 채팅', members: [me.settings.primaryAgent], mode: 'chat' })).data.room.id;
  await api('POST', `/api/rooms/${chatId}/messages`, { text: '졸업전시 주제 고민 중이야' });
  const msgs = await idle(chatId);
  assert.equal(msgs.filter((m) => m.sender !== 'user' && m.sender !== 'system').length, 1);
  const rooms = (await api('GET', '/api/rooms')).data.rooms;
  assert.equal(rooms.find((r) => r.id === chatId).name, '졸업전시 주제 고민 중이야');
});

test('/크리틱: 세 시점이 서로를 보지 않고 사용자 기준표로 채점 → 종합 리포트', async () => {
  mockLog.length = 0;
  const before = (await messages(chatId)).messages.length;
  await api('POST', `/api/rooms/${chatId}/messages`, { text: '/크리틱 의자 콘셉트 보드야\n기준: 문제 정의, 소재 선택 근거, 형태 완성도' });
  const msgs = (await idle(chatId)).slice(before);
  const lens = msgs.filter((m) => m.meta?.lens);
  assert.deepEqual(lens.map((m) => m.meta.lens).sort(), ['detail', 'professor', 'user']);
  const report = msgs.at(-1);
  assert.equal(report.meta.kind, 'team-report');
  const lensPrompts = mockLog.filter((l) => l.prompt.includes('크리틱 리허설 ·') && !l.prompt.includes('종합'));
  assert.equal(lensPrompts.length, 3);
  for (const l of lensPrompts) {
    assert.match(l.prompt, /소재 선택 근거/, '사용자 기준표가 들어감');
    for (const m of lens) assert.ok(!l.prompt.includes(m.text), '다른 시점의 결과를 보지 않음');
  }
  const synth = mockLog.find((l) => l.prompt.includes('크리틱 리허설 · 종합'));
  for (const m of lens) assert.ok(synth.prompt.includes(m.text), '종합은 세 시점을 모두 받음');
});

test('/리서치: 팩트시트 → 교차 검증(판정 포함), /검증: 직전 답을 한 번 검증', async () => {
  const before = (await messages(chatId)).messages.length;
  await api('POST', `/api/rooms/${chatId}/messages`, { text: '/리서치 국내 친환경 가구 시장 규모' });
  let msgs = (await idle(chatId)).slice(before);
  assert.deepEqual(msgs.filter((m) => m.meta?.team === 'research' && m.sender !== 'system').map((m) => m.meta.label), ['팩트시트', '교차 검증']);
  assert.ok(msgs.find((m) => m.meta?.label === '교차 검증').meta.verdict);

  const b2 = (await messages(chatId)).messages.length;
  await api('POST', `/api/rooms/${chatId}/messages`, { text: '/검증' });
  msgs = (await idle(chatId)).slice(b2);
  const v = msgs.find((m) => m.meta?.team === 'verify');
  assert.ok(v.meta.replyTo, '어느 답을 검증했는지 남김');
  assert.ok(v.meta.verdict);
});

test('/비교: 1명 답과 팀 답을 섞어 보여주고, 고르면 공개 + 인사이트에 쌓인다', async () => {
  const before = (await messages(chatId)).messages.length;
  await api('POST', `/api/rooms/${chatId}/messages`, { text: '/비교 졸업전시 주제 3개 추천해줘' });
  const msgs = (await idle(chatId)).slice(before);
  const card = msgs.find((m) => m.meta?.kind === 'compare');
  assert.ok(card.meta.options.A && card.meta.options.B);
  assert.ok(!card.meta.reveal, '고르기 전에는 누가 썼는지 숨김');
  const r = await api('POST', `/api/evals/${card.meta.evalId}/choose`, { roomId: chatId, choice: 'A', reason: '더 구체적' });
  assert.equal(r.status, 200);
  const after = (await messages(chatId)).messages.find((m) => m.id === card.id);
  assert.equal(after.meta.choice, 'A');
  assert.ok(['single', 'team'].includes(after.meta.reveal.A));
  const { insights } = (await api('GET', '/api/insights')).data;
  assert.equal(insights.total.n, 1);
  assert.equal(insights.byKind['컨셉'].n, 1, '"주제 추천"은 컨셉 유형으로 분류');
  assert.equal((await api('POST', `/api/evals/${card.meta.evalId}/choose`, { roomId: chatId, choice: 'X' })).status, 400);
});

test('/컨셉: 1:1 채팅에서도 스튜디오 팀을 불러 브리프 → 내 차례(컨펌 A)로 멈춘다', async () => {
  await api('POST', `/api/rooms/${chatId}/messages`, { text: '/컨셉 졸업전시 의자' });
  const msgs = await idle(chatId);
  assert.equal(msgs.at(-1).meta.kind, 'gate');
  const room = (await api('GET', '/api/rooms')).data.rooms.find((r) => r.id === chatId);
  assert.equal(room.project.awaiting, 'A');
  await api('POST', `/api/rooms/${chatId}/project/cancel`);
});

test('로그인 안 된 AI: 오류 대신 "AI 연결" 안내(needsLogin)를 남긴다', async () => {
  await api('POST', `/api/rooms/${chatId}/messages`, { text: '안녕 #nologin' });
  const msgs = await idle(chatId);
  const err = msgs.at(-1);
  assert.equal(err.meta.kind, 'error');
  assert.equal(err.meta.needsLogin, true);
  assert.match(err.text, /로그인되어 있지 않습니다/);
});
