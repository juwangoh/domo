'use strict';
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || '0.0.0.0';

// AITALK_DEMO=1 이면 실제 AI 대신 mock 엔진으로 동작한다 (요금 없음, UI 체험용).
const demo = process.env.AITALK_DEMO === '1';
const { server, auth } = createApp({
  password: process.env.AITALK_PASSWORD,
  dataDir: process.env.AITALK_DATA || (demo ? require('node:path').join(__dirname, 'data-demo') : undefined),
  agentOverrides: demo ? { engine: 'mock', mockDelayMs: 1500 } : undefined,
  port: PORT,
  enableTunnel: !demo,
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n◐ DOMO가 실행 중입니다${demo ? ' (데모 모드: mock AI)' : ''}`);
  console.log(`   이 컴퓨터:   http://localhost:${PORT}`);
  for (const ip of lan) console.log(`   폰(같은 Wi‑Fi): http://${ip}:${PORT}`);
  if (!auth.hasAccount) {
    console.log('\n👋 처음 실행입니다. 위 주소를 브라우저로 열고 회원가입(내 DOMO 계정 만들기)을 하세요.');
    console.log(`   다른 기기(폰·Codespace 주소)에서 가입할 때 필요한 설정 코드: ${auth.setupCode}`);
    if (process.env.CODESPACES) console.log('   Codespace: 아래 "포트" 탭의 3939 주소를 여세요. AI 연결은 이 터미널에서 `claude` 와 `codex login` 으로 본인 계정에 로그인하면 됩니다.');
  }
  console.log('');
  // 서버가 켜져 있는 동안 맥이 유휴 잠자기에 들지 않게 한다 (이 프로세스가 끝나면 자동 해제).
  if (process.platform === 'darwin' && !demo && process.env.AITALK_NO_CAFFEINATE !== '1') {
    try { spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref(); } catch { /* 없음 */ }
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
