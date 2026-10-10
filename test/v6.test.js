'use strict';
// 플러그인 추가·로그인·AI별 허용, 자동화(매번 새 채팅 · 실행 기록)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const PASSWORD = 'v6-pass';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-v6-'));
const calls = [];
let loginDone;
// claude CLI 흉내: 등록한 서버를 기억하고, 로그인하기 전에는 '로그인 필요'로 보여 준다.
const servers = new Map();
const pluginRun = async (bin, args) => {
  calls.push(args.join(' '));
  if (args[1] === 'add') servers.set(args.at(-2), { url: args.at(-1), authed: false });
  if (args[1] === 'remove') servers.delete(args.at(-1));
  if (args[1] === 'login') { await new Promise((r) => { loginDone = r; }); servers.get(args[2]).authed = true; }
  if (args[1] === 'list') return { err: null, stderr: '', stdout: [...servers].map(([n, s]) => `${n}: ${s.url} (HTTP) - ${s.authed ? '✔ Connected' : '! Needs authentication'}`).join('\n') };
  return { err: null, stdout: '', stderr: '' };
};
let app;
let cookie;
async function api(method, p, body, headers = {}) {
  const res = await fetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie || '', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const agents = async () => (await api('GET', '/api/me')).data.agents;

test.before(async () => {
  app = createApp({ dataDir, password: PASSWORD, agentOverrides: { engine: 'mock', mockDelayMs: 10 }, enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws'), pluginRun });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  const res = await fetch(`${app.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
  await api('PATCH', '/api/settings', { autoMemory: false });
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('플러그인: 목록에서 골라 추가 → 로그인 → AI별 허용 → 삭제', async () => {
  const first = await api('GET', '/api/plugins');
  assert.ok(first.data.catalog.some((c) => c.id === 'notion'));
  assert.equal((await api('POST', '/api/plugins', { preset: 'nope' })).status, 400);

  const added = await api('POST', '/api/plugins', { preset: 'notion' });
  assert.equal(added.status, 201);
  assert.ok(calls.includes('mcp add --scope user --transport http Notion https://mcp.notion.com/mcp'));
  const p = added.data.plugins.find((x) => x.name === 'Notion');
  assert.equal(p.source, 'domo');
  assert.equal(p.status, 'needs-auth');
  assert.ok((await agents()).every((a) => a.plugins.includes('Notion')), '추가하면 모든 AI가 바로 쓸 수 있다');

  // 다른 기기에서는 로그인(브라우저 열기)을 시작할 수 없다
  assert.equal((await api('POST', '/api/plugins/Notion/login', {}, { 'X-Forwarded-For': '203.0.113.5' })).status, 403);
  const during = await api('POST', '/api/plugins/Notion/login', {});
  assert.equal(during.data.plugins.find((x) => x.name === 'Notion').loggingIn, true);
  loginDone();
  await new Promise((r) => setTimeout(r, 20));
  const after = (await api('GET', '/api/plugins')).data.plugins.find((x) => x.name === 'Notion');
  assert.equal(after.status, 'connected');
  assert.equal(after.loggingIn, false);

  const [one] = await agents();
  await api('PUT', '/api/plugins/Notion/agents', { agents: [one.id] });
  assert.deepEqual((await agents()).filter((a) => a.plugins.includes('Notion')).map((a) => a.id), [one.id]);

  // 토큰 방식은 DOMO 설정 파일에만 저장한다
  await api('POST', '/api/plugins', { name: 'my api', url: 'https://example.com/mcp', token: 'abc' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'), 'utf8')).mcpServers.my_api.headers.Authorization, 'Bearer abc');

  const gone = await api('DELETE', '/api/plugins/Notion');
  assert.ok(!gone.data.plugins.some((x) => x.name === 'Notion'));
  assert.ok(calls.includes('mcp remove --scope user Notion'));
  assert.ok((await agents()).every((a) => !a.plugins.includes('Notion')));
});

test('자동화: 매번 새 채팅을 만들어 실행하고 실행 기록을 남긴다', async () => {
  const [agent] = await agents();
  const s = (await api('POST', '/api/schedules', { name: '아침 브리핑', target: 'new', agentId: agent.id, time: '08:30', days: [1, 2, 3, 4, 5], prompt: '오늘 할 일 정리해줘' })).data.schedule;
  assert.equal(s.target, 'new');
  const before = (await api('GET', '/api/rooms')).data.rooms.length;
  app.scheduler.now = () => new Date(2026, 9, 12, 8, 31); // 월요일
  app.scheduler.tick();
  const rooms = (await api('GET', '/api/rooms')).data.rooms;
  assert.equal(rooms.length, before + 1);
  const room = rooms.find((r) => r.name === '아침 브리핑 · 10/12');
  assert.deepEqual(room.members, [agent.id]);
  const saved = (await api('GET', '/api/schedules')).data.schedules.find((x) => x.id === s.id);
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].roomId, room.id);

  // 지금 실행: 대상이 없으면 이유를 알려 준다
  assert.equal((await api('POST', `/api/schedules/${s.id}/run`)).status, 200);
  const broken = (await api('POST', '/api/schedules', { name: '고장', roomId: 'no-such-room', prompt: 'x' })).data.schedule;
  assert.equal((await api('POST', `/api/schedules/${broken.id}/run`)).status, 404);
  assert.equal((await api('PATCH', `/api/schedules/${s.id}`, { enabled: false })).data.schedule.enabled, false);
  // 실행한 대화가 끝날 때까지 기다린다
  for (let i = 0; i < 300 && (await api('GET', '/api/rooms')).data.rooms.some((r) => r.running); i++) await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => setTimeout(r, 100));
});

test('앱 업데이트: 새 버전 확인 → 내려받아 검증 → 설치 넘기기, 앱이 아닐 때는 없음', async () => {
  const { Updater, newer } = require('../desktop/updater');
  assert.ok(newer('v1.10.0', '1.9.3'));
  assert.ok(!newer('1.1.0', '1.1.0'));
  assert.equal((await api('GET', '/api/app-update')).data.update.status, 'none');

  const body = Buffer.from('new installer');
  const digest = `sha256:${require('node:crypto').createHash('sha256').update(body).digest('hex')}`;
  const release = (d) => ({ tag_name: 'v9.0.0', assets: [{ name: 'DOMO-windows.exe', size: body.length, digest: d, browser_download_url: 'https://example.com/DOMO-windows.exe' }] });
  let rel = release(digest);
  const fetchImpl = async (url) => (String(url).includes('api.github.com') ? new Response(JSON.stringify(rel)) : new Response(body, { headers: { 'content-length': String(body.length) } }));
  let quit = 0;
  const up = new Updater({ version: '1.1.0', packaged: true, platform: 'win32', quit: () => { quit++; }, fetchImpl });
  let installed = null;
  // 실제 설치 프로그램은 실행하지 않고, 넘겨받은 파일만 확인한다.
  Object.defineProperty(up, 'platform', { value: 'test', writable: true });
  assert.equal((await up.check()).status, 'latest', '이 플랫폼용 파일이 없으면 업데이트 없음');
  up.platform = 'win32';
  assert.equal((await up.check()).status, 'available');

  // 파일 지문이 다르면 설치하지 않는다
  rel = release('sha256:deadbeef');
  await up.check();
  const bad = await up.install();
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /원본과 다릅니다/);
  assert.equal(quit, 0);

  // 개발 모드(설치된 앱이 아님)에서는 설치하지 않는다
  const dev = new Updater({ version: '1.1.0', packaged: false, platform: 'win32', fetchImpl });
  assert.equal((await dev.install()).status, 'error');
  assert.equal(installed, null);
});
