'use strict';
// 스튜디오 모드: 분류 → 사고형은 컨펌 A(가설) · B(방향) · C(시안) 사이에서 멈췄다가 내 답으로 재개, 내 기준 학습.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { mockLog } = require('../src/engines');

const PASSWORD = 'studio-pass';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-studio-'));
let app;
let cookie;
let roomId;
const ids = {};

async function api(method, p, body) {
  const res = await fetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie || '' }, body: body ? JSON.stringify(body) : undefined });
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
const messages = async () => (await api('GET', `/api/rooms/${roomId}/messages`)).data;
const idle = () => waitFor(async () => {
  const d = await messages();
  return !d.running && d.messages.at(-1)?.sender !== 'user' ? d.messages : null;
});
const project = async () => (await api('GET', '/api/rooms')).data.rooms.find((r) => r.id === roomId).project;
const say = async (text) => { await api('POST', `/api/rooms/${roomId}/messages`, { text }); return idle(); };

test.before(async () => {
  app = createApp({ configPath: require('node:path').join(__dirname, 'fixtures', 'agents.legacy.json'), dataDir, password: PASSWORD, agentOverrides: { engine: 'mock', mockDelayMs: 10 }, enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  cookie = (await api('POST', '/api/login', { password: PASSWORD })).setCookie.split(';')[0];
  await api('PATCH', '/api/settings', { autoMemory: false });
  for (const [role, name] of [['pm', '플랜'], ['research', '서치'], ['concept', '에디슨'], ['critic', '릭']]) {
    ids[role] = (await api('POST', '/api/agents', { name, engine: 'mock', studioRole: role })).data.agent.id;
  }
  await api('PATCH', '/api/agents/claude', { studioRole: 'producer' });
  await api('PATCH', '/api/agents/codex', { studioRole: 'verifier' });
  ids.producer = 'claude';
  ids.verifier = 'codex';
  const room = (await api('POST', '/api/rooms', { name: '스튜디오', members: [ids.pm, ids.research, ids.concept, ids.critic, 'claude', 'codex'], mode: 'studio' })).data.room;
  assert.equal(room.mode, 'studio');
  roomId = room.id;
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('사고형: 브리프 후 컨펌 A에서 멈추고, 상태가 저장되어 서버를 다시 켜도 유지된다', async () => {
  const msgs = await say('졸업전시 판넬 컨셉 잡아줘');
  const brief = msgs.find((m) => m.meta?.studio === 'brief');
  assert.equal(brief.sender, ids.pm);
  assert.ok(!/유형\s*:/.test(brief.text), '분류 줄은 말풍선에서 뺀다');
  assert.equal(msgs.at(-1).meta.kind, 'gate');
  assert.equal(msgs.at(-1).meta.gate, 'A');
  const p = await project();
  assert.equal(p.awaiting, 'A');
  assert.equal(p.title, '테스트 프로젝트');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).rooms.find((r) => r.id === roomId);
  assert.equal(saved.project.awaiting, 'A');
});

test('컨펌 A 답변 → 서치·에디슨 독립 발산 → 릭·코덱스 크리틱 → 결정 카드 → 컨펌 B에서 멈춤', async () => {
  mockLog.length = 0;
  const msgs = await say('내 가설은 로컬 소재가 핵심이라는 것');
  const by = (phase) => msgs.find((m) => m.meta?.studio === phase);
  assert.equal(by('facts').sender, ids.research);
  assert.equal(by('directions').sender, ids.concept);
  assert.equal(by('critique').sender, ids.critic);
  assert.equal(by('verify').sender, 'codex');
  assert.equal(by('decision').sender, ids.pm);
  const gate = msgs.at(-1);
  assert.equal(gate.meta.gate, 'B');
  assert.deepEqual(gate.meta.actions.map((a) => a.label), ['A안', 'B안', 'C안']);
  // 독립 실행: 컨셉터는 대화 전체가 아니라 브리프 + 내 답만 받고, 세션 없이 시작한다
  const concept = mockLog.find((c) => c.agentId === ids.concept);
  assert.equal(concept.sessionId, null);
  assert.match(concept.prompt, /내 가설은 로컬 소재/);
  assert.ok(!concept.prompt.includes('팩트시트 (서치)'), '서치 결과를 보지 않고 독립적으로 낸다');
  // 크리틱은 내 기준 루브릭 자리를 받는다
  assert.match(mockLog.find((c) => c.agentId === ids.critic).prompt, /\[내 기준\]/);
  assert.equal((await project()).awaiting, 'B');
});

test('컨펌 B 방향 선택 → 내 기준 학습 → 프로듀서 시안 + 크리틱·검증 → 컨펌 C', async () => {
  const msgs = await say('B안으로 진행, 덜 장식적이라서 좋아');
  assert.ok(msgs.some((m) => m.meta?.kind === 'memory' && m.text.startsWith('내 기준에 추가')));
  const draft = msgs.find((m) => m.meta?.studio === 'produce');
  assert.equal(draft.sender, 'claude');
  assert.ok(msgs.some((m) => m.meta?.studio === 'review' && m.sender === ids.critic));
  assert.ok(msgs.some((m) => m.meta?.studio === 'check' && m.sender === 'codex'));
  assert.equal(msgs.at(-1).meta.gate, 'C');
  const mem = (await api('GET', '/api/memory')).data.memory;
  assert.ok(mem.principles.length >= 1);
  assert.equal(mem.principles[0].learned, true);
});

test('컨펌 C 수정 요청 → 같은 프로듀서 세션으로 수정 → 다시 컨펌 C → 컨펌 → 확정 + 프로젝트 보고 + 과제 등록', async () => {
  mockLog.length = 0;
  let msgs = await say('제목을 더 크게 키워줘');
  const revise = msgs.filter((m) => m.meta?.studio === 'revise');
  assert.equal(revise.length, 1);
  const call = mockLog.find((c) => c.agentId === 'claude');
  assert.ok(call.sessionId, '시안을 만든 세션을 이어서 고친다');
  assert.equal(msgs.at(-1).meta.gate, 'C');
  assert.equal((await project()).round, 1);

  msgs = await say('컨펌');
  assert.ok(msgs.some((m) => m.meta?.studio === 'final'));
  const report = msgs.at(-1);
  assert.equal(report.meta.studio, 'report');
  assert.equal(report.meta.kind, 'minutes');
  assert.equal(report.meta.tasks.length, 1);
  const p = await project();
  assert.equal(p.stage, 'done');
  assert.equal(p.awaiting, null);
});

test('실행형은 컨펌 없이 끝까지, 학습형은 설명 + 재진술 요청', async () => {
  let msgs = await say('#실행 제네시스 동향 조사해줘');
  assert.ok(msgs.some((m) => m.meta?.kind === 'assign'));
  assert.equal(msgs.at(-1).meta.label, '작업 보고');
  assert.ok(!msgs.slice(-8).some((m) => m.meta?.kind === 'gate'));

  msgs = await say('#학습 게슈탈트 원리가 뭐야');
  assert.equal(msgs.at(-1).meta.studio, 'teach');
  assert.match(msgs.at(-1).text, /다시 말해 보세요/);
});

test('/중단 으로 멈춘 프로젝트를 닫는다', async () => {
  await say('/스튜디오 로고 방향 잡아줘');
  assert.equal((await project()).awaiting, 'A');
  await say('/중단');
  const p = await project();
  assert.equal(p.stage, 'done');
  assert.equal(p.cancelled, true);
});
