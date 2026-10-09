'use strict';
// 반복 작업 → 자동 스킬: 3번째에 등록, 비슷한 작업 합치기, 개수 제한, 오래 안 쓰면 보관, 고정은 보관 안 됨.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Skills, MAX_ACTIVE, ARCHIVE_DAYS } = require('../src/skills');
const { createApp } = require('../src/app');

const DAY = 864e5;
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-skills-'));
  let t = Date.UTC(2026, 9, 1);
  const s = new Skills(dir, path.join(dir, 'ws'), { now: () => t });
  return { s, dir, tick: (days) => { t += days * DAY; }, skillDir: path.join(dir, 'ws', '.claude', 'skills') };
};
const P = (key, name = key) => ({ key, name, description: `${name} 할 때`, steps: ['하나', '둘', '셋'] });

test('같은 작업이 3번 나오면 스킬 파일이 생기고, 비슷한 표현은 하나로 합친다', () => {
  const { s, skillDir } = fresh();
  assert.equal(s.observe(P('판넬 문구 다듬기')).activated, false);
  assert.equal(s.observe(P('졸업전시 판넬 문구 다듬기', '판넬 문구')).activated, false, '비슷한 요청은 같은 작업으로 센다');
  const third = s.observe(P('판넬 문구 다듬기 부탁'));
  assert.equal(third.activated, true);
  assert.equal(s.list().length, 1);
  const files = fs.readdirSync(skillDir);
  assert.equal(files.length, 1);
  const md = fs.readFileSync(path.join(skillDir, files[0], 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: domo-/);
  assert.match(md, /## 절차\n1\. 하나/);
  assert.match(s.promptText(), /판넬/);
});

test(`활성 스킬은 최대 ${MAX_ACTIVE}개: 넘치면 가장 오래 안 쓴 것을 보관하고 파일도 지운다 (고정은 제외)`, () => {
  const { s, tick, skillDir } = fresh();
  const names = Array.from({ length: MAX_ACTIVE + 1 }, (_, i) => `작업${String.fromCharCode(65 + i)} 정리`);
  for (const n of names) { for (let k = 0; k < 3; k++) s.observe(P(n)); tick(1); }
  const first = s.list().find((x) => x.key === names[0]);
  assert.equal(first.status, 'archived', '가장 오래 안 쓴 첫 스킬이 보관됨');
  assert.equal(s.active().length, MAX_ACTIVE);
  assert.equal(fs.readdirSync(skillDir).length, MAX_ACTIVE);

  // 고정한 스킬은 제한을 넘겨도 보관되지 않는다
  const second = s.list().find((x) => x.key === names[1]);
  s.update(second.id, { pinned: true });
  for (let k = 0; k < 3; k++) s.observe(P('새작업Z 정리'));
  assert.equal(s.list().find((x) => x.id === second.id).status, 'active');
});

test(`${ARCHIVE_DAYS}일 동안 안 쓴 스킬은 자동 보관, 다시 반복되면 되살아난다`, () => {
  const { s, tick } = fresh();
  for (let k = 0; k < 3; k++) s.observe(P('리서치 출처 정리'));
  tick(ARCHIVE_DAYS + 1);
  s.observe(P('완전히 다른 일'));
  const x = s.list().find((i) => i.key === '리서치 출처 정리');
  assert.equal(x.status, 'archived');
  assert.match(x.archivedWhy, /쓰지 않음/);
  s.observe(P('리서치 출처 정리'));
  assert.equal(s.list().find((i) => i.id === x.id).status, 'active', '보관된 작업이 다시 나오면 다시 활성');
});

test('대화가 끝나면 기억 정리가 반복 작업을 세고, 3번째에 대화에 등록 알림 + API로 관리', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-skills-app-'));
  const app = createApp({ dataDir, password: 'skill-pass-1', agentOverrides: { engine: 'mock', mockDelayMs: 5 }, enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws'), configPath: path.join(__dirname, 'fixtures', 'agents.legacy.json') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'skill-pass-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined })).json();
  for (let i = 0; i < 3; i++) {
    await call('POST', '/api/rooms/dm-claude/messages', { text: `판넬 문구 좀 봐줘 #repeat-panel ${i}` });
    await new Promise((r) => setTimeout(r, 400));
    await app.orch.curating.get('dm-claude');
  }
  const { messages } = await call('GET', '/api/rooms/dm-claude/messages');
  assert.ok(messages.some((m) => /스킬로 등록했어요/.test(m.text)));
  const { skills, limits } = await call('GET', '/api/skills');
  assert.equal(skills[0].status, 'active');
  assert.equal(limits.activateAt, 3);
  assert.ok(fs.existsSync(path.join(dataDir, 'ws', '.claude', 'skills', `domo-${skills[0].slug}`, 'SKILL.md')));
  await call('DELETE', `/api/skills/${skills[0].id}`);
  assert.equal(fs.readdirSync(path.join(dataDir, 'ws', '.claude', 'skills')).length, 0, '지우면 파일도 사라짐');
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
