'use strict';
// AI 연결 버튼: 설치(없을 때만) → 로그인 → 연결됨. 실제 설치·로그인 대신 같은 모양의 가짜 프로세스로 검증한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { Connections } = require('../src/connections');

const PASSWORD = 'setup-pass';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-setup-'));
const mark = (name) => path.join(dataDir, `mark-${name}`);
const has = (name) => fs.existsSync(mark(name));
const node = (script) => [process.execPath, ['-e', script]];
let app;
let cookie;

// 설치·로그인 여부를 표시 파일로 흉내 낸다.
class FakeConnections extends Connections {
  async status() {
    const st = (t) => ({ installed: has(`${t}-installed`), loggedIn: has(`${t}-loggedin`) });
    return { claude: st('claude'), codex: st('codex'), codespace: false };
  }
}
const commands = {
  claude: {
    installed: () => has('claude-installed'),
    install: node(`console.log('내려받는 중');require('fs').writeFileSync(${JSON.stringify(mark('claude-installed'))},'')`),
    // 주소를 출력하고, 코드를 한 줄 받으면 로그인된 것으로 한다.
    login: node(`console.log('If the browser didn\\'t open, visit: https://example.com/oauth/authorize?x=1');process.stdin.once('data',(d)=>{require('fs').writeFileSync(${JSON.stringify(mark('claude-loggedin'))},String(d).trim());process.exit(0)})`),
  },
  codex: {
    installed: () => has('codex-installed'),
    install: node(`console.error('network down');process.exit(1)`),
    login: node('setTimeout(()=>{},60000)'),
  },
};

async function api(method, p, body, headers = {}) {
  const res = await fetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie || '', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
async function waitFor(fn, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('시간 초과');
}
const phase = async (tool, want) => waitFor(async () => {
  const j = (await api('GET', '/api/ai-setup')).data.setup[tool];
  return j?.phase === want ? j : null;
});

test.before(async () => {
  app = createApp({ dataDir, password: PASSWORD, agentOverrides: { engine: 'mock', mockDelayMs: 10 }, enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws'), connections: new FakeConnections(), aiSetupCommands: commands });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  const res = await fetch(`${app.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
test.after(async () => {
  app.aiSetup.stop();
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('이 컴퓨터에서 열면 버튼으로 연결할 수 있다고 알려 준다', async () => {
  const local = await api('GET', '/api/connections');
  assert.equal(local.data.connections.canSetup, true);
  const remote = await api('GET', '/api/connections', null, { 'X-Forwarded-For': '203.0.113.5' });
  assert.equal(remote.data.connections.canSetup, false);
  const denied = await api('POST', '/api/ai-setup/claude/connect', {}, { 'X-Forwarded-For': '203.0.113.5' });
  assert.equal(denied.status, 403);
});

test('설치 → 로그인 주소 표시 → 코드 입력 → 연결됨', async () => {
  assert.equal((await api('POST', '/api/ai-setup/claude/connect', {})).status, 200);
  const login = await waitFor(async () => {
    const j = (await api('GET', '/api/ai-setup')).data.setup.claude;
    return j?.phase === 'login' && j.url ? j : null;
  });
  assert.ok(has('claude-installed'));
  assert.equal(login.url, 'https://example.com/oauth/authorize?x=1');
  assert.equal((await api('POST', '/api/ai-setup/claude/code', { code: 'bad code' })).status, 400);
  assert.equal((await api('POST', '/api/ai-setup/claude/code', { code: 'abc#123' })).status, 200);
  await phase('claude', 'done');
  assert.equal(fs.readFileSync(mark('claude-loggedin'), 'utf8'), 'abc#123');
  assert.equal((await api('GET', '/api/connections?refresh')).data.connections.claude.loggedIn, true);
});

test('설치에 실패하면 이유와 함께 다시 시도할 수 있게 알려 준다', async () => {
  await api('POST', '/api/ai-setup/codex/connect', {});
  const j = await phase('codex', 'error');
  assert.match(j.error, /설치하지 못했습니다/);
  assert.match(j.error, /network down/);
});

test('로그인을 기다리다 취소하면 프로세스를 끝낸다', async () => {
  fs.writeFileSync(mark('codex-installed'), '');
  await api('POST', '/api/ai-setup/codex/connect', {});
  await phase('codex', 'login');
  const child = app.aiSetup.jobs.codex.child;
  assert.equal((await api('POST', '/api/ai-setup/codex/cancel', {})).status, 200);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  assert.equal((await api('GET', '/api/ai-setup')).data.setup.codex, null);
  assert.equal((await api('POST', '/api/ai-setup/nope/connect', {})).status, 404);
});
