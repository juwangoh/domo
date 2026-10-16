'use strict';
// v1.3.0 기준: 크리틱 리허설 — 읽기 확인 → 시점별 크리틱 → 검증 → 위치 지정 → 종합, 지적 구조·판정·실제 결과·비용 기록.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { mockLog } = require('../src/engines');
const critique = require('../src/critique');
const { CritiqueStore, LocalAdapter, ExampleBank } = require('../src/critiques');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domo-v8-'));
let app;
let cookie;
let roomId;

async function api(method, p, body) {
  const res = await fetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), setCookie: res.headers.get('set-cookie') };
}
const messages = async (id) => (await api('GET', `/api/rooms/${id}/messages`)).data;
async function idle(id) {
  for (let i = 0; i < 600; i++) {
    const d = await messages(id);
    if (!d.running && d.messages.at(-1)?.sender !== 'user') return d.messages;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('시간 초과');
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const upload = async (name) => (await api('POST', `/api/rooms/${roomId}/upload`, { name, type: 'image/png', data: PNG })).data.file;
const steps = () => mockLog.map((l) => l.prompt.match(/\[크리틱 단계: (\w+)\]/)?.[1]).filter(Boolean);

test.before(async () => {
  app = createApp({ dataDir, agentOverrides: { engine: 'mock', mockDelayMs: 5 }, enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws'), connections: { fake: { claude: { loggedIn: true }, codex: { loggedIn: true } } } });
  app.profiles.updateSettings({ autoMemory: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  cookie = (await api('POST', '/api/signup', { name: '테스트', email: 't@example.com', password: 'longpassword' })).setCookie.split(';')[0];
  await api('POST', '/api/onboarding', { answers: { job: '대학생', field: '산업디자인', tasks: ['critique'], tone: 'direct' } });
  roomId = (await api('POST', '/api/rooms', { members: [app.profiles.settings.primaryAgent] })).data.room.id;
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
});

let cid;
test('읽기 확인: 크리틱 전에 이해한 내용을 보여 주고 멈춘다 (호출 1회)', async () => {
  const [a, aAxis, b] = [await upload('01.png'), await upload('01-axis.png'), await upload('02.png')];
  mockLog.length = 0;
  await api('POST', `/api/rooms/${roomId}/messages`, {
    text: '/크리틱 용도:공모전 단계:최종 FIELD SCORE 판넬', files: [a.id, b.id],
    critique: { purpose: 'contest', stage: 'final', course: '제품디자인', field: '제품', medium: '판넬', slides: [{ fileId: a.id, aiFileId: aAxis.id, width: 1400 }, { fileId: b.id, width: 1200 }] },
  });
  const msgs = await idle(roomId);
  const card = msgs.at(-1);
  assert.equal(card.meta.kind, 'critique-read');
  cid = card.meta.critiqueId;
  assert.deepEqual(steps(), ['read']);
  const { critique: C } = (await api('GET', `/api/critiques/${cid}`)).data;
  assert.equal(C.status, 'confirm');
  assert.equal(C.purpose, 'contest');
  assert.equal(C.read.ai.concept, '테스트 컨셉 한 문장');
  assert.deepEqual(C.slides.map((s) => [s.n, s.axis]), [[1, true], [2, false]]);
  assert.ok(!('private' in C), '이름 등은 응답에 넣지 않는다');
  assert.match(mockLog[0].prompt, /01번: .*\(가장자리에 0~100 좌표축/);
});

test('확인 후: 시점 3 → 검증 1 → 위치 지정 1 → 종합 1 로 나눠 부르고, 확인한 사실이 모든 시점에 들어간다', async () => {
  mockLog.length = 0;
  const r = await api('POST', `/api/critiques/${cid}/confirm`, { read: { concept: '고친 컨셉' }, confirmedFacts: '화장실 위치는 현장 답사로 확인함' });
  assert.equal(r.status, 200);
  const msgs = await idle(roomId);
  assert.deepEqual(steps().sort(), ['check', 'lens', 'lens', 'lens', 'locate', 'synth']);
  const lens = mockLog.filter((l) => l.prompt.includes('[크리틱 단계: lens]'));
  for (const l of lens) {
    assert.match(l.prompt, /사용자가 직접 확인한 사실[\s\S]*현장 답사로 확인함/);
    assert.match(l.prompt, /컨셉: 고친 컨셉/);
    assert.match(l.prompt, /1점 = 문제 없이 결과물만 제시/, '점수 앵커');
    assert.match(l.prompt, /항목별 비중: 문제 정의 15%/, '공모전 비중');
    assert.ok(!l.prompt.includes('수치에 출처가 없다'), '다른 시점의 결과를 보지 않음');
  }
  assert.equal(lens.filter((l) => /심사위원 관점/.test(l.prompt)).length, 1, '용도에 따라 보는 사람이 바뀜');
  assert.match(lens.find((l) => /디테일 관점/.test(l.prompt)).prompt, /공모전 체크[\s\S]*지속가능성/);
  // 앞부분(루브릭·규칙)은 시점이 달라도 글자가 같다 → 캐싱 대상
  assert.ok(lens.every((l) => l.prompt.includes(critique.RUBRIC_BLOCK)));

  const report = msgs.at(-1);
  assert.equal(report.meta.kind, 'critique-report');
  assert.match(report.text, /기대 기준: [\s\S]*격차: [\s\S]*개선 방향\(안전\)[\s\S]*개선 방향\(실험\)/);
  const { critique: C } = (await api('GET', `/api/critiques/${cid}`)).data;
  assert.equal(C.status, 'done');
  assert.equal(C.read.edited, true);
  assert.equal(C.issues.length, 6);
  const x = C.issues[0];
  assert.deepEqual(Object.keys(x).sort(), ['criterion', 'evidence_type', 'fixes', 'gap', 'id', 'lens', 'location', 'severity', 'standard', 'user_reason', 'user_verdict', 'viewpoint']);
  assert.equal(new Set(C.issues.map((i) => i.id)).size, 6);
  assert.ok(x.fixes.length >= 2 && x.fixes.some((f) => f.type === '안전') && x.fixes.some((f) => f.type === '실험'));
  assert.equal(x.location.slide >= 1 && x.location.region, '좌측 하단');
  assert.deepEqual(x.location.x, [0, 40]);
  assert.equal(x.user_verdict, '미판정');
  assert.ok(C.checks.some((c) => c.result === '문제' && /합계/.test(c.item)));
  assert.equal(C.synth.top3.length, 2);
  // 가중 평균: 가짜 점수 2,3,4,2,3 × 공모전 비중 15,10,25,30,20
  assert.equal(C.table.total, (2 * 15 + 3 * 10 + 4 * 25 + 2 * 30 + 3 * 20) / 100);
  // 비용 기록: 호출 7회 (읽기 1 + 나머지 6)
  assert.equal(C.totals.calls, 7);
  assert.deepEqual(C.calls.map((c) => c.step).sort(), ['check', 'lens', 'lens', 'lens', 'locate', 'read', 'synth']);
  assert.ok(C.calls.every((c) => 'model' in c && 'ms' in c && 'costUsd' in c && 'tokensIn' in c));
});

test('판정: 이유를 적어야 저장된다 · 실제 결과 입력', async () => {
  assert.equal((await api('POST', `/api/critiques/${cid}/issues/p1/verdict`, { verdict: '오판', reason: ' ' })).status, 400);
  assert.equal((await api('POST', `/api/critiques/${cid}/issues/p1/verdict`, { verdict: '모름', reason: '이유' })).status, 400);
  assert.equal((await api('POST', `/api/critiques/${cid}/issues/zz/verdict`, { verdict: '맞음', reason: '이유' })).status, 404);
  const ok = await api('POST', `/api/critiques/${cid}/issues/p1/verdict`, { verdict: '오판', reason: '현장에서 확인한 내용이다' });
  assert.equal(ok.data.issue.user_verdict, '오판');
  assert.equal((await api('POST', `/api/critiques/${cid}/outcome`, {})).status, 400);
  assert.equal((await api('POST', `/api/critiques/${cid}/outcome`, { feedback: '교수님: 근거 수치 보강', score: 'A-' })).status, 200);
  const { critique: C } = (await api('GET', `/api/critiques/${cid}`)).data;
  assert.equal(C.issues.find((i) => i.id === 'p1').user_reason, '현장에서 확인한 내용이다');
  assert.equal(C.outcome.score, 'A-');
  const row = (await api('GET', '/api/critiques')).data.critiques.find((c) => c.id === cid);
  assert.deepEqual([row.judged, row.outcome], [1, true]);
});

test('아이디어 단계: 점수를 매기지 않는다 · 글로 답해도 진행된다 · 형식이 깨지면 원문을 보여 준다', async () => {
  mockLog.length = 0;
  await api('POST', `/api/rooms/${roomId}/messages`, { text: '/크리틱 단계:아이디어 초기 스케치 #broken' });
  let msgs = await idle(roomId);
  const id2 = msgs.at(-1).meta.critiqueId;
  await api('POST', `/api/rooms/${roomId}/messages`, { text: '사이트는 대구 수성못이 맞아' });
  msgs = await idle(roomId);
  const { critique: C } = (await api('GET', `/api/critiques/${id2}`)).data;
  assert.equal(C.purpose, 'class');
  assert.equal(C.stage, 'idea');
  assert.equal(C.table, null);
  assert.deepEqual(C.read.confirmedFacts, ['사이트는 대구 수성못이 맞아']);
  assert.equal(C.raw.length, 3, '세 시점 모두 원문으로 남는다');
  assert.match(msgs.at(-1).text, /형식을 읽지 못해 원문 그대로/);
  assert.ok(!steps().includes('locate'), '지적이 없으면 위치 지정 호출을 하지 않는다');
  assert.match(mockLog.find((l) => l.prompt.includes('[크리틱 단계: lens]')).prompt, /결론을 닫는 지적을 하지 않는다/);
});

test('기준 데이터: 용도별 비중 합 100 · 비헨스 자동 체크 · 옵션 읽기 · 단계별 모델 설정', () => {
  for (const p of Object.values(critique.PURPOSES)) {
    assert.equal(Object.values(p.weights).reduce((a, b) => a + b, 0), 100);
    assert.equal(p.lenses.length, 3);
  }
  const few = critique.autoChecks('behance', [{ n: 1, width: 1400 }, { n: 2, width: 1000 }]);
  assert.deepEqual(few.map((c) => c.result), ['문제', '문제']);
  assert.match(few[1].note, /02번 1000px/);
  assert.deepEqual(critique.autoChecks('class', []), []);
  assert.deepEqual(critique.parseOptions('/크리틱 용도:비헨스 단계:중간 포트폴리오'), { purpose: 'behance', stage: 'mid', request: '포트폴리오' });
  assert.equal(app.profiles.settings.critiqueModels.lens, 'claude-sonnet-5-5', '기본은 팀 기본 모델');
  const s = app.profiles.updateSettings({ critiqueModels: { read: '', lens: '', synth: '', locate: 'claude-haiku-4-5-20251001', check: '없는모델' }, dataConsent: true });
  assert.deepEqual(s.critiqueModels, { locate: 'claude-haiku-4-5-20251001' });
  assert.equal(app.orch.stepModel('locate', { engine: 'claude' }), 'claude-haiku-4-5-20251001');
  assert.equal(app.orch.stepModel('locate', { engine: 'codex' }), null, '다른 회사 모델에는 적용하지 않는다');
});

test('예시 은행: 동의한 기록의 "맞음" 판정만 · 충분히 쌓이기 전에는 꺼져 있다', () => {
  const store = new CritiqueStore(new LocalAdapter(fs.mkdtempSync(path.join(os.tmpdir(), 'domo-bank-'))));
  const mk = (consent, field) => {
    const r = store.create({ roomId: 'r', purpose: 'class', stage: 'final', input: { field }, consent, person: { name: '홍길동' } });
    store.update(r.id, { issues: [{ id: 'p1', lens: 'professor', criterion: '전달력', standard: 's', gap: `${field} g`, fixes: [], user_verdict: '맞음' }, { id: 'p2', user_verdict: '오판' }] });
  };
  for (let i = 0; i < 3; i++) mk(true, i ? '제품' : 'UX');
  mk(false, '제품');
  assert.equal(new ExampleBank(store).pick({ field: '제품' }).length, 0, '30개 전에는 비활성');
  const bank = new ExampleBank(store, { min: 3 });
  assert.deepEqual(bank.status(), { count: 3, min: 3, active: true });
  assert.equal(bank.pick({ field: 'UX', purpose: 'class' })[0].gap, 'UX g', '태그가 많이 겹치는 예시 먼저');
  assert.ok(!JSON.stringify(bank.pool()).includes('홍길동'));
});
