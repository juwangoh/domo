'use strict';
// AI 연결을 버튼 하나로: 공식 설치 스크립트를 대신 실행하고(없을 때만), 공식 CLI 의 로그인 명령을 대신 실행한다.
// 로그인은 브라우저에서 사용자가 직접 하고, 로그인 정보는 공식 CLI 가 보관한다. DOMO 는 다루지 않는다.
const { spawn } = require('node:child_process');
const { WIN, resolveBin, spawnBin, killTree } = require('./bins');

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const powershell = (script) => ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]];
const TOOLS = {
  claude: {
    bin: 'claude',
    install: () => (WIN
      ? powershell('irm https://claude.ai/install.ps1 | iex')
      : ['bash', ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']]),
    login: ['auth', 'login'],
  },
  codex: {
    bin: 'codex',
    install: () => (WIN
      ? powershell('irm https://chatgpt.com/codex/install.ps1 | iex')
      : ['sh', ['-c', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh']]),
    login: ['login'],
  },
};

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

class AiSetup {
  // commands: 테스트용으로 실행할 명령을 바꾼다. { claude: { install: [cmd, args], login: [cmd, args], installed: () => bool } }
  constructor({ connections, commands = {}, onChange } = {}) {
    this.connections = connections;
    this.commands = commands;
    this.onChange = onChange;
    this.jobs = {};
  }

  status() {
    const out = {};
    for (const tool of Object.keys(TOOLS)) {
      const j = this.jobs[tool];
      // steps: 이번 연결에서 거치는 단계(설치가 필요 없으면 설치 단계는 빠진다). since: 지금 단계를 시작한 시각(경과 시간 표시용).
      out[tool] = j ? { phase: j.phase, url: j.url, error: j.error, detail: j.detail || '', failedAt: j.failedAt || null, line: j.lines.at(-1) || '', steps: j.steps, since: j.since, now: Date.now() } : null;
    }
    return out;
  }

  #installed(tool) {
    return this.commands[tool]?.installed ? this.commands[tool].installed() : !!resolveBin(TOOLS[tool].bin);
  }

  // 설치(없을 때만) → 로그인까지 이어서 진행한다. 진행 상황은 status() 로 확인한다.
  connect(tool) {
    if (!TOOLS[tool]) return { error: '알 수 없는 AI 입니다.', status: 404 };
    const cur = this.jobs[tool];
    if (cur && ['install', 'login', 'verify'].includes(cur.phase)) return { ok: true };
    const phase = this.#installed(tool) ? 'login' : 'install';
    const steps = phase === 'install' ? ['install', 'login', 'verify'] : ['login', 'verify'];
    const job = { phase, steps, since: Date.now(), url: null, error: null, detail: '', lines: [], child: null, cancelled: false };
    this.jobs[tool] = job;
    this.#run(tool, job).catch((err) => this.#end(tool, job, 'error', err.message));
    return { ok: true };
  }

  async #run(tool, job) {
    if (job.phase === 'install') {
      const [cmd, args] = this.commands[tool]?.install || TOOLS[tool].install();
      const code = await this.#exec(job, () => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODEX_NON_INTERACTIVE: '1' }, windowsHide: true }), INSTALL_TIMEOUT_MS);
      if (job.cancelled) return;
      if (code !== 0 || !this.#installed(tool)) return this.#end(tool, job, 'error', code === null ? '설치하지 못했습니다. 시간이 너무 오래 걸렸어요. 인터넷 연결을 확인하고 다시 시도해 주세요.' : '설치하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.', job.lines.slice(-6).join('\n'));
      this.#step(job, 'login');
      job.lines = [];
      this.onChange?.();
    }
    const custom = this.commands[tool]?.login;
    const code = await this.#exec(job, () => (custom
      ? spawn(custom[0], custom[1], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawnBin(TOOLS[tool].bin, TOOLS[tool].login, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })), LOGIN_TIMEOUT_MS);
    if (job.cancelled) return;
    this.#step(job, 'verify');
    this.connections?.invalidate();
    const st = await this.connections?.status({ refresh: true });
    if (code === 0 && (!st || st[tool]?.loggedIn)) return this.#end(tool, job, 'done');
    if (code === 0 && st && !st[tool]?.loggedIn) return this.#end(tool, job, 'error', '로그인은 끝났지만 연결을 확인하지 못했어요. 유료 구독 계정인지 확인하고 다시 시도해 주세요.', st[tool]?.error || '');
    this.#end(tool, job, 'error', code === null ? '로그인 시간이 지났습니다. 다시 시도해 주세요.' : '로그인을 마치지 못했습니다. 브라우저 창을 닫았다면 다시 시도해 주세요.', job.lines.slice(-6).join('\n'));
  }

  // 프로세스를 실행하고 출력에서 로그인 주소와 마지막 줄을 모은다. 종료 코드를 돌려준다 (시간 초과는 null).
  #exec(job, start, timeoutMs) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = start(); } catch (err) { return reject(err); }
      job.child = child;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const onData = (d) => {
        for (const line of stripAnsi(d).split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          job.lines.push(t);
          if (job.lines.length > 30) job.lines.shift();
          const url = t.match(/https:\/\/\S+/)?.[0];
          if (url && job.phase === 'login' && /oauth|auth/i.test(url)) job.url = url;
        }
        this.onChange?.();
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.stdin?.on('error', () => { /* 프로세스가 먼저 끝난 경우 */ });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); job.child = null; resolve(timedOut ? null : code); });
    });
  }

  #step(job, phase) {
    job.phase = phase;
    job.since = Date.now();
    this.onChange?.();
  }

  // error: 사용자에게 보여 줄 안내, detail: 설치·로그인 프로그램이 남긴 원문 ("자세히"에서만 보인다)
  #end(tool, job, phase, error = null, detail = '') {
    if (this.jobs[tool] !== job) return;
    if (phase === 'error') job.failedAt = job.phase;
    job.phase = phase;
    job.error = error;
    job.detail = String(detail || '').slice(0, 1200);
    job.since = Date.now();
    job.child = null;
    this.onChange?.();
  }

  // 브라우저가 로그인 코드를 보여 준 경우(자동으로 돌아오지 못했을 때) 그 코드를 CLI 에 넘긴다.
  submitCode(tool, code) {
    const job = this.jobs[tool];
    const text = String(code || '').trim();
    if (!job?.child || job.phase !== 'login') return { error: '진행 중인 로그인이 없습니다.', status: 409 };
    if (!text || text.length > 500 || /\s/.test(text)) return { error: '코드를 다시 확인해 주세요.', status: 400 };
    job.child.stdin?.write(`${text}\n`);
    return { ok: true };
  }

  cancel(tool) {
    const job = this.jobs[tool];
    if (!job) return { ok: true };
    job.cancelled = true;
    if (job.child) killTree(job.child);
    delete this.jobs[tool];
    this.onChange?.();
    return { ok: true };
  }

  stop() {
    for (const tool of Object.keys(this.jobs)) this.cancel(tool);
  }
}

module.exports = { AiSetup };
