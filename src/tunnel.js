'use strict';
// LTE 등 외부망 접속.
//  · tailscale  : Tailscale Funnel → https://<맥이름>.<tailnet>.ts.net  (고정 주소, 무료, 폰에 앱 불필요)
//  · cloudflare : Cloudflare 빠른 터널 → https://xxxx.trycloudflare.com (계정 불필요, 켤 때마다 주소가 바뀜)
// provider 'auto' 는 Tailscale 이 설치·로그인되어 있으면 Tailscale, 아니면 Cloudflare 를 쓴다.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TAILSCALE_BINS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale'];

// macOS Tailscale 앱 실행 파일은 터미널이 아니면 GUI 로 뜨려고 한다. 이 값이 있어야 CLI 로 동작한다 (백그라운드 서비스용).
const TS_ENV = { ...process.env, TAILSCALE_BE_CLI: '1' };

function run(bin, args, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: TS_ENV }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

class Tunnel {
  constructor({ rootDir, dataDir, port, onChange, getProvider = () => 'auto', tailscaleBin, cloudflaredBin }) {
    this.cfBin = cloudflaredBin !== undefined ? cloudflaredBin
      : [path.join(rootDir, 'bin', 'cloudflared'), '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find((p) => fs.existsSync(p)) || null;
    this.tsBin = tailscaleBin !== undefined ? tailscaleBin : TAILSCALE_BINS.find((p) => fs.existsSync(p)) || null;
    this.urlFile = path.join(dataDir, 'tunnel-url.txt');
    this.port = port;
    this.onChange = onChange;
    this.getProvider = getProvider;
    this.child = null;
    this.state = {
      status: 'off', url: null, error: null, provider: null, fixed: false, enableUrl: null,
      available: !!(this.cfBin || this.tsBin),
      tailscale: { installed: !!this.tsBin, loggedIn: false, host: null },
    };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange?.({ ...this.state, tailscale: { ...this.state.tailscale } });
  }

  // Tailscale 설치·로그인 상태와, 이미 켜져 있는 Funnel 을 확인한다 (Funnel 은 Tailscale 이 기억하므로 재시작 후에도 유지됨).
  async refresh() {
    if (!this.tsBin) return this.state;
    const st = await run(this.tsBin, ['status', '--json']);
    let host = null;
    let loggedIn = false;
    try {
      const j = JSON.parse(st.stdout);
      loggedIn = j.BackendState === 'Running';
      host = (j.Self?.DNSName || '').replace(/\.$/, '') || null;
    } catch { /* 데몬이 꺼져 있음 */ }
    this.state.tailscale = { installed: true, loggedIn, host };
    if (loggedIn && host && !this.child && this.state.status !== 'starting') {
      const on = await this.funnelOn(host);
      if (on) this.set({ status: 'on', url: `https://${host}`, provider: 'tailscale', fixed: true, error: null, enableUrl: null });
      else if (this.state.provider === 'tailscale' && this.state.status === 'on') this.set({ status: 'off', url: null });
      else this.set({});
    } else this.set({});
    return this.state;
  }

  async funnelOn(host) {
    const r = await run(this.tsBin, ['funnel', 'status', '--json']);
    try {
      const j = JSON.parse(r.stdout);
      return Object.entries(j.AllowFunnel || {}).some(([k, v]) => v && k.startsWith(`${host}:`));
    } catch { return false; }
  }

  async resolveProvider() {
    const want = this.getProvider();
    if (want === 'cloudflare') return 'cloudflare';
    if (this.tsBin) {
      await this.refresh();
      if (this.state.tailscale.loggedIn || want === 'tailscale') return 'tailscale';
    }
    return want === 'tailscale' ? 'tailscale' : 'cloudflare';
  }

  async start() {
    if (this.child || this.state.status === 'starting') return;
    const provider = await this.resolveProvider();
    if (provider === 'tailscale') return this.startTailscale();
    return this.startCloudflare();
  }

  async startTailscale() {
    if (!this.tsBin) { this.set({ status: 'error', provider: 'tailscale', error: 'Tailscale 앱이 설치되어 있지 않습니다.' }); return; }
    if (!this.state.tailscale.loggedIn) { this.set({ status: 'error', provider: 'tailscale', error: 'Tailscale 앱에서 로그인한 뒤 다시 켜세요.' }); return; }
    const host = this.state.tailscale.host;
    this.set({ status: 'starting', provider: 'tailscale', fixed: true, url: null, error: null, enableUrl: null });
    // --bg: Tailscale 이 설정을 기억해서, 이 서버나 맥을 재시작해도 같은 주소가 유지된다.
    const child = spawn(this.tsBin, ['funnel', '--bg', String(this.port)], { stdio: ['ignore', 'pipe', 'pipe'], env: TS_ENV });
    this.child = child;
    let log = '';
    const onData = (d) => {
      log = (log + d).slice(-4000);
      // Funnel 이 tailnet 에서 아직 허용되지 않았으면, 허용 링크를 띄우고 사용자가 누를 때까지 기다린다.
      const enable = log.match(/https:\/\/login\.tailscale\.com\/[^\s]+/);
      if (enable && this.state.enableUrl !== enable[0]) this.set({ enableUrl: enable[0] });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { this.child = null; this.set({ status: 'error', error: err.message }); });
    child.on('close', async (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) { this.stopping = false; return; }
      if (code === 0 && host && await this.funnelOn(host)) {
        const url = `https://${host}`;
        fs.writeFileSync(this.urlFile, url);
        this.set({ status: 'on', url, error: null, enableUrl: null });
        return;
      }
      const why = log.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^https?:\/\//.test(l)).pop() || `코드 ${code}`;
      this.set({ status: 'error', url: null, error: `Tailscale Funnel 을 켜지 못했습니다: ${why}` });
    });
  }

  startCloudflare() {
    if (!this.cfBin) { this.set({ status: 'error', provider: 'cloudflare', error: 'cloudflared 가 없습니다.' }); return; }
    this.set({ status: 'starting', provider: 'cloudflare', fixed: false, url: null, error: null, enableUrl: null });
    const child = spawn(this.cfBin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let log = '';
    const onData = (d) => {
      log = (log + d).slice(-4000);
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && this.state.url !== m[0]) {
        fs.writeFileSync(this.urlFile, m[0]);
        this.set({ status: 'on', url: m[0] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { this.child = null; this.set({ status: 'error', error: err.message }); });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) { this.stopping = false; this.set({ status: 'off', url: null }); return; }
      this.set({ status: 'error', url: null, error: `터널이 종료되었습니다 (코드 ${code}). ${log.split('\n').filter((l) => /ERR|error/i.test(l)).pop() || ''}`.trim() });
    });
  }

  async stop() {
    if (this.child) {
      this.stopping = true;
      this.child.kill('SIGTERM');
      this.child = null;
    }
    if (this.state.provider === 'tailscale' && this.tsBin) {
      await run(this.tsBin, ['funnel', '--https=443', 'off']);
      this.stopping = false;
    }
    this.set({ status: 'off', url: null, error: null, enableUrl: null });
  }

  // 서버 종료 시: 임시 터널 프로세스만 정리하고, Tailscale Funnel(고정 주소)은 그대로 둔다.
  shutdown() {
    if (this.child && this.state.provider === 'cloudflare') { this.stopping = true; this.child.kill('SIGTERM'); }
  }
}

module.exports = { Tunnel };
