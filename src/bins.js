'use strict';
// claude · codex 실행 파일을 찾아서 실행한다.
// 앱(더블클릭)으로 켜면 셸의 PATH 가 없으므로 공식 설치 위치를 직접 찾아본다. Windows 의 .exe / .cmd 도 여기서 처리한다.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';

function extraDirs() {
  const home = os.homedir();
  if (!WIN) return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [path.join(home, '.local', 'bin'), path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'), path.join(roaming, 'npm')];
}

function searchDirs() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of extraDirs()) if (!dirs.includes(d)) dirs.push(d);
  return dirs;
}

// 자식 프로세스(claude 가 부르는 git·node 등)도 같은 위치를 보도록 PATH 에 더해 둔다.
function ensurePath() {
  process.env.PATH = searchDirs().join(path.delimiter);
}

// 이름이면 전체 경로를 찾아 돌려주고(없으면 null), 경로면 그대로 돌려준다.
function resolveBin(name) {
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) return name;
  const exts = WIN ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of searchDirs()) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* 없음 */ }
    }
  }
  return null;
}

const winQuote = (a) => `"${String(a).replace(/"/g, '""')}"`;

// spawn 과 같지만 이름을 직접 찾고, Windows 에서는 창을 띄우지 않으며 .cmd 는 셸로 실행한다.
function spawnBin(name, args = [], opts = {}) {
  const bin = resolveBin(name);
  if (!bin) {
    const err = new Error(`spawn ${name} ENOENT`);
    err.code = 'ENOENT';
    throw err;
  }
  if (WIN && /\.(cmd|bat)$/i.test(bin)) {
    return spawn(`"${[bin, ...args].map(winQuote).join(' ')}"`, [], { ...opts, shell: true, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(bin, args, { ...opts, windowsHide: true });
}

// 한 번 실행하고 출력을 모아서 돌려준다. 실패해도 reject 하지 않는다 (err 로 알려 준다).
function runBin(name, args = [], { timeout = 15_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnBin(name, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { return resolve({ err, stdout: '', stderr: '' }); }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child), timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ err, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ err: code === 0 ? null : Object.assign(new Error(`종료 코드 ${code}`), { code }), stdout, stderr }); });
  });
}

// 자식이 띄운 프로세스(도구 실행 등)까지 함께 끝낸다. group: detached 로 띄운 프로세스 그룹인지.
function killTree(child, { group = false, signal = 'SIGTERM' } = {}) {
  if (!child?.pid) return;
  if (WIN) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {}); } catch { /* 이미 종료 */ }
    return;
  }
  try { process.kill(group ? -child.pid : child.pid, signal); } catch { /* 이미 종료 */ }
}

module.exports = { WIN, resolveBin, spawnBin, runBin, killTree, ensurePath, extraDirs };
