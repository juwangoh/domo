'use strict';
// v2 기준: 회의 모드, 프로필·페르소나, 모델 변경, 플러그인, 장기 기억, 예약 작업, 비밀번호 변경.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { mockLog } = require('../src/engines');

const PASSWORD = 'first-pass';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-v2-'));
let app;
let cookie;

async function api(method, p, body, c = cookie) {
  const res = await fetch(app.base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(c ? { Cookie: c } : {}) },
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
const messages = async (roomId) => (await api('GET', `/api/rooms/${roomId}/messages`)).data;
const idle = (roomId) => waitFor(async () => {
  const d = await messages(roomId);
  return !d.running && d.messages.at(-1)?.sender !== 'user' ? d.messages : null;
});

test.before(async () => {
  app = createApp({ configPath: require('node:path').join(__dirname, 'fixtures', 'agents.legacy.json'),
    dataDir, password: PASSWORD, agentOverrides: { engine: 'mock', mockDelayMs: 10 },
    enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws'), hermesDir: path.join(__dirname, 'fixtures', 'hermes'),
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  cookie = (await api('POST', '/api/login', { password: PASSWORD })).setCookie.split(';')[0];
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('회의: 의장 개회 → 돌아가며 토론 → 합의 시 조기 종료 → 회의록 + 할 일이 과제로 등록', async () => {
  await api('PATCH', '/api/settings', { autoMemory: false });
  mockLog.length = 0;
  await api('POST', '/api/rooms/meeting/messages', { text: '졸업전시 주제 정하기' });
  const msgs = await idle('meeting');
  const flow = msgs.map((m) => (m.sender === 'system' ? `system:${m.meta?.kind}` : `${m.sender}${m.meta?.stance ? `:${m.meta.stance}` : ''}`));
  assert.deepEqual(flow, [
    'user', 'system:meeting-start',
    'claude:disagree', 'codex:disagree', // 1라운드
    'claude:agree', 'codex:agree', // 2라운드 모두 합의
    'system:pass', 'claude', // 의장 회의록
  ]);
  const minutes = msgs.at(-1);
  assert.equal(minutes.meta.kind, 'minutes');
  assert.equal(minutes.meta.tasks.length, 1);
  const { memory } = (await api('GET', '/api/memory')).data;
  const task = memory.tasks.find((t) => t.id === minutes.meta.tasks[0]);
  assert.equal(task.title, '회의에서 나온 할 일');
  assert.equal(task.due, '2026-10-02');
  assert.equal(task.owner, '나');
  // 의장 첫 발언 지시와 토론 지시가 다르다
  assert.match(mockLog[0].prompt, /당신이 의장/);
  assert.match(mockLog[1].prompt, /동의·반박·보완/);
  assert.ok(mockLog[1].prompt.includes(msgs[2].text), '참석자는 의장 발언을 받아야 함');
});

test('"/회의" 로 검토 방에서도 이번만 회의로 진행된다', async () => {
  await api('POST', '/api/rooms/group/messages', { text: '/회의 #agree 짧게 정리' });
  const msgs = await idle('group');
  assert.ok(msgs.some((m) => m.meta?.kind === 'minutes'));
  assert.ok(!msgs.some((m) => m.meta?.verdict));
});

test('프로필: 만들기·이름·사진·페르소나·성격이 AI 시스템 프롬프트에 반영된다', async () => {
  const avatar = `data:image/png;base64,${Buffer.from('fakepng').toString('base64')}`;
  const { data } = await api('POST', '/api/agents', {
    name: '설인', title: '감사실장', engine: 'mock', personality: 'critic',
    soul: '너는 감사실장 설인이다. 거짓말을 절대 넘기지 않는다.', avatar,
  });
  const a = data.agent;
  assert.equal(a.avatar, avatar);
  const bad = await api('PATCH', `/api/agents/${a.id}`, { avatar: 'javascript:alert(1)' });
  assert.equal(bad.data.agent.avatar, null, '이미지가 아닌 값은 거부');

  const room = (await api('POST', '/api/rooms', { members: [a.id] })).data.room;
  mockLog.length = 0;
  await api('POST', `/api/rooms/${room.id}/messages`, { text: '안녕' });
  await idle(room.id);
  const sys = mockLog[0].agent.systemPrompt;
  assert.match(sys, /감사실장 설인이다/);
  assert.match(sys, /아첨 없이 직설적으로/); // critic 성격
  assert.match(sys, /Claude Code 위에서 동작/);
});

test('모델 변경: 바꾼 모델·추론 강도가 다음 차례부터 엔진에 전달된다', async () => {
  await api('PATCH', '/api/agents/claude', { model: 'claude-sonnet-5', effort: 'high' });
  mockLog.length = 0;
  await api('POST', '/api/rooms/dm-claude/messages', { text: '모델 테스트' });
  await idle('dm-claude');
  assert.equal(mockLog[0].agent.model, 'claude-sonnet-5');
  assert.equal(mockLog[0].agent.effort, 'high');
  const msgs = (await messages('dm-claude')).messages;
  assert.equal(msgs.at(-1).meta.model, 'claude-sonnet-5');
});

test('권한·플러그인: 노션·피그마를 켜면 해당 MCP 도구가 허용되고, 권한 단계에 따라 도구가 바뀐다', async () => {
  await api('PATCH', '/api/agents/claude', { plugins: ['claude.ai Notion', 'claude.ai Figma'], permission: 'edit' });
  mockLog.length = 0;
  await api('POST', '/api/rooms/dm-claude/messages', { text: '노션 확인' });
  await idle('dm-claude');
  const { allowedTools, disallowedTools, sandbox } = mockLog[0].agent;
  assert.ok(allowedTools.includes('mcp__claude_ai_Notion'));
  assert.ok(allowedTools.includes('mcp__claude_ai_Figma'));
  assert.ok(allowedTools.includes('Edit') && !allowedTools.includes('Bash'));
  assert.deepEqual(disallowedTools, ['Bash']);
  assert.equal(sandbox, 'workspace-write');

  const added = await api('POST', '/api/plugins', { name: 'my server', url: 'https://example.com/mcp' });
  assert.equal(added.data.name, 'my_server');
  assert.ok(added.data.plugins.some((p) => p.name === 'my_server' && p.source === 'custom'));
  assert.equal((await api('POST', '/api/plugins', { name: 'x', url: 'file:///etc' })).status, 400);
  await api('DELETE', '/api/plugins/my_server');
});

test('기억: 대화가 끝나면 내 정보·과제·프로젝트를 자동으로 기억하고 다른 대화방 AI도 안다', async () => {
  await api('PATCH', '/api/settings', { autoMemory: true });
  await api('POST', '/api/rooms/dm-claude/messages', { text: '#remember 나는 디자인대학 산업디자인 전공이야 #task 졸업작품 콘셉트 보드 제출' });
  const msgs = await waitFor(async () => {
    const m = (await messages('dm-claude')).messages;
    return m.at(-1)?.meta?.kind === 'memory' ? m : null;
  });
  assert.match(msgs.at(-1).text, /기억함/);
  const { memory } = (await api('GET', '/api/memory')).data;
  assert.ok(memory.user.some((u) => u.text.includes('산업디자인')));
  const task = memory.tasks.find((t) => t.title === '졸업작품 콘셉트 보드 제출');
  const proj = memory.projects.find((p) => p.name === '테스트 프로젝트');
  assert.equal(task.projectId, proj.id, '과제가 프로젝트에 연결됨');
  assert.ok(memory.roomSummaries['dm-claude']);

  // 다른 방의 AI가 이 기억을 시스템 프롬프트로 받는다
  mockLog.length = 0;
  await api('POST', '/api/rooms/dm-codex/messages', { text: '내 전공 기억해?' });
  await idle('dm-codex');
  const first = mockLog.find((l) => l.agentId === 'codex');
  assert.match(first.agent.systemPrompt, /산업디자인/);
  assert.match(first.agent.systemPrompt, /졸업작품 콘셉트 보드 제출/);
  assert.match(first.agent.systemPrompt, /다른 대화방 최근 요약/);
});

test('기억: 사이트에서 직접 추가·수정·완료 처리, Hermes 기억 가져오기', async () => {
  const p = (await api('POST', '/api/memory/projects', { name: '브랜드 리서치', desc: '카피탈·비즈빔' })).data.item;
  const t = (await api('POST', '/api/memory/tasks', { title: '무드보드', due: '2026-10-05', projectId: p.id })).data.item;
  await api('PATCH', `/api/memory/tasks/${t.id}`, { status: 'done' });
  assert.equal((await api('POST', '/api/memory/user', { text: '' })).status, 400);
  const imp = (await api('POST', '/api/memory/import-hermes')).data;
  assert.equal(imp.added, 3);
  assert.equal((await api('POST', '/api/memory/import-hermes')).data.added, 0, '두 번 가져와도 중복 없음');
  const { memory } = (await api('GET', '/api/memory')).data;
  assert.equal(memory.tasks.find((x) => x.id === t.id).status, 'done');
  assert.ok(memory.user.some((u) => u.text.includes('Design University')));
});

test('예약 작업: 정해진 요일·시각에 한 번만 대화방으로 보낸다', async () => {
  const s = (await api('POST', '/api/schedules', { name: '아침 회의', roomId: 'dm-claude', time: '08:00', days: [1], prompt: '오늘 할 일 정리해줘' })).data.schedule;
  const before = (await messages('dm-claude')).messages.length;
  const monday8 = new Date(2026, 8, 28, 8, 3); // 2026-09-28 월 08:03
  app.scheduler.now = () => monday8;
  app.scheduler.tick();
  app.scheduler.tick(); // 같은 날 두 번 실행되지 않음
  app.scheduler.now = () => new Date(2026, 8, 29, 8, 3); // 화요일은 요일 불일치
  app.scheduler.tick();
  const msgs = (await idle('dm-claude')).slice(before);
  const sent = msgs.filter((m) => m.sender === 'user');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].meta.scheduleName, '아침 회의');
  assert.equal((await api('PATCH', `/api/schedules/${s.id}`, { time: '99:99' })).data.schedule.time, '08:00', '잘못된 시각은 무시');
});

test('사용자 프로필 이름 변경이 AI에게 전달되고, 비밀번호 변경 후 이전 비밀번호는 거부된다', async () => {
  await api('PATCH', '/api/profile', { name: '테스터' });
  assert.equal((await api('GET', '/api/me')).data.user.name, '테스터');
  assert.equal((await api('POST', '/api/password', { current: 'wrong', next: 'new-pass-5678' })).status, 400);
  const r = await api('POST', '/api/password', { current: PASSWORD, next: 'new-pass-5678' });
  assert.equal(r.status, 200);
  cookie = r.setCookie.split(';')[0];
  assert.equal((await api('GET', '/api/me')).status, 200, '바꾼 기기는 로그인 유지');
  assert.equal((await api('POST', '/api/login', { password: PASSWORD }, null)).status, 401);
  assert.equal((await api('POST', '/api/login', { password: 'new-pass-5678' }, null)).status, 200);
});

test('회의록 작성 시 과거 대화가 대화기록 폴더에 남아 AI가 검색할 수 있다', async () => {
  const file = path.join(dataDir, 'ws', '대화기록', 'meeting.md');
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8'), /졸업전시 주제 정하기/);
});
