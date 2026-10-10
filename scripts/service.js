'use strict';
// 서버를 macOS 백그라운드 서비스(launchd)로 등록한다.
//  · 로그인하면 자동으로 켜지고, 죽으면 다시 켜진다 (터미널을 닫아도 계속 동작)
//  · 서버가 도는 동안 맥이 유휴 잠자기에 들지 않는다 (server.js 가 caffeinate 를 건다. 덮개를 닫으면 잠듦)
// 사용: npm run service -- install | uninstall | status | restart
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  console.log('이 명령은 macOS 전용입니다. Windows 에서는 DOMO 앱의 트레이 메뉴에서 "컴퓨터를 켤 때 자동으로 실행"을 켜세요.');
  process.exit(0);
}

const LABEL = 'com.aitalk.server';
const root = path.join(__dirname, '..');
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const log = path.join(root, 'data', 'server.log');
const domain = `gui/${process.getuid()}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const launchctl = (...args) => {
  try { return execFileSync('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { return e.stderr?.toString() || e.message; }
};

function install() {
  // claude / codex CLI 를 찾을 수 있도록 PATH 를 넘긴다.
  const PATH = [path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const args = [process.execPath, path.join(root, 'server.js')];
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(PATH)}</string>
    <key>HOME</key><string>${esc(os.homedir())}</string>
    <key>LANG</key><string>ko_KR.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`);
  launchctl('bootout', `${domain}/${LABEL}`);
  const out = launchctl('bootstrap', domain, plist);
  if (out.trim()) console.log(out.trim());
  console.log(`✅ 백그라운드 서비스로 등록했습니다: ${plist}`);
  console.log(`   로그: ${log}`);
  console.log('   이제 터미널을 닫아도, 맥을 재시동해도 자동으로 켜집니다.');
}

function uninstall() {
  launchctl('bootout', `${domain}/${LABEL}`);
  fs.rmSync(plist, { force: true });
  console.log('서비스를 해제했습니다. 이제 npm start 로 직접 실행하세요.');
}

function status() {
  const out = launchctl('print', `${domain}/${LABEL}`);
  const state = out.match(/state = (\S+)/)?.[1];
  const pid = out.match(/pid = (\d+)/)?.[1];
  console.log(state ? `상태: ${state}${pid ? ` (pid ${pid})` : ''}` : '등록되어 있지 않습니다. npm run service -- install');
}

const cmd = process.argv[2] || 'status';
if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'restart') { console.log(launchctl('kickstart', '-k', `${domain}/${LABEL}`).trim() || '다시 시작했습니다.'); }
else status();
