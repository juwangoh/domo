'use strict';
// 1회 실행: 기존 페르소나 6명을 스튜디오 역할로 재설계하고, 기존 기억에서 "내 기준"을 미리 채우고, 회사 방을 스튜디오 모드로 바꾼다.
// 실행 전 data/*.backup-studio.json 으로 백업한다. 서버를 멈춘 상태에서 실행할 것 (npm run service -- uninstall 또는 launchctl bootout).
const fs = require('node:fs');
const path = require('node:path');
const { soulFor } = require('../src/profiles');

const dataDir = process.argv[2] || path.join(__dirname, '..', 'data');
const file = (n) => path.join(dataDir, n);
const read = (n) => JSON.parse(fs.readFileSync(file(n), 'utf8'));
const write = (n, d) => fs.writeFileSync(file(n), JSON.stringify(d, null, 1));

for (const n of ['profiles.json', 'store.json', 'memory.json']) {
  const backup = file(n.replace('.json', '.backup-studio.json'));
  if (!fs.existsSync(backup)) fs.copyFileSync(file(n), backup);
}

const profiles = read('profiles.json');
const user = profiles.user?.name || '나';
// 이름은 유지하고 역할·SOUL·모델만 바꾼다. extra 는 기존 SOUL에서 사용자가 직접 넣었던 결을 이어받은 것.
const PLAN = {
  'a-55e47e': { role: 'pm', title: 'PM', model: 'claude-sonnet-5', effort: 'medium' },
  'a-ee9874': { role: 'research', title: '리서처', model: 'claude-sonnet-5', effort: 'low', extra: '[결] 조사한 사실에서 디렉터가 쓸 수 있는 인사이트를 "해석" 칸에 담는다.' },
  'a-c592e4': { role: 'concept', title: '컨셉터', model: 'claude-sonnet-5', effort: 'medium' },
  'a-f1060b': { role: 'critic', title: '크리틱', model: 'claude-sonnet-5', effort: 'medium', extra: '[전문] 패션·산업디자인 크리틱. 브랜드·소재·제조 관점에 강하다.' },
  claude: { role: 'producer', title: '프로듀서', model: 'claude-opus-5-5', effort: 'medium' },
  codex: { role: 'verifier', title: '검증', model: '', effort: 'low' },
};
for (const a of profiles.agents) {
  const p = PLAN[a.id];
  if (!p) continue;
  a.soulBackup ||= a.soul;
  Object.assign(a, { studioRole: p.role, title: p.title, model: p.model, effort: p.effort, soul: [soulFor(p.role, a.name, user), p.extra].filter(Boolean).join('\n') });
}
write('profiles.json', profiles);

// 내 기준: 기억에 흩어져 있던 판단 기준을 옮겨 둔다 (이후 컨펌에서 자동으로 더 쌓인다).
const memory = read('memory.json');
memory.principles ||= [];
const SEED = [
  '아첨 없이 직설적으로 말한다. 결론부터, 근거는 짧게.',
  '사고형 과제는 내 1차 가설을 먼저 묻고, 그 가설을 공격·대안·트레이드오프로 다룬다. 실행형은 묻지 않고 바로 실행한다.',
  '확인되지 않은 사실로 서사를 확정하지 않는다. 미확인은 가설이라고 표시한다.',
  '사이트는 맥락과 FLOW로 public movement pattern을 정의하고, 그 패턴으로 디자인한다.',
  '피그마 장표는 ux-figma-slides, 한국어 문구는 juwang-writing-style을 반드시 적용한다.',
  '피그마 자료는 16:9, 오토레이아웃·중첩 없이 평평한 레이어로, 단락 하나는 텍스트박스 하나로 만든다.',
  '한국어 맞춤법을 엄격히 지킨다.',
];
const norm = (s) => s.replace(/\s+/g, '');
let added = 0;
for (const text of SEED) {
  if (memory.principles.some((x) => norm(x.text) === norm(text))) continue;
  memory.principles.push({ id: Math.random().toString(36).slice(2, 10), ts: Date.now(), text, source: '기존 기억에서 옮김', learned: false });
  added++;
}
memory.version = (memory.version || 1) + 1;
write('memory.json', memory);

// 회사 방: 스튜디오 모드. 작업 모드에서 쓰던 세션은 새 역할로 다시 시작한다.
const store = read('store.json');
const room = store.rooms.find((r) => r.id === 'meeting');
if (room) {
  room.mode = 'studio';
  room.members = ['a-55e47e', 'a-ee9874', 'a-c592e4', 'a-f1060b', 'claude', 'codex'].filter((id) => profiles.agents.some((a) => a.id === id));
  room.agentState = {};
}
write('store.json', store);

console.log(`페르소나 ${Object.keys(PLAN).length}명 재설계 · 내 기준 ${added}개 추가 · ${room ? `"${room.name}" 방을 스튜디오 모드로` : '회사 방 없음'}`);
