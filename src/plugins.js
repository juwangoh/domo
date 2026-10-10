'use strict';
// 플러그인 = Claude Code 의 MCP 서버. claude.ai 연결(노션·피그마 등) + 사이트에서 직접 추가한 서버.
const fs = require('node:fs');
const path = require('node:path');
const { runBin } = require('./bins');

const CACHE_MS = 10 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// 버튼 하나로 추가할 수 있는 플러그인. 모두 서비스가 직접 운영하는 공식 원격 MCP 서버이고, 브라우저 로그인으로 연결한다.
const CATALOG = [
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', desc: '노션 페이지와 데이터베이스를 읽고 씁니다' },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', desc: '피그마 파일을 읽고 디자인을 만듭니다' },
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', desc: '캔바 디자인을 찾고 만듭니다' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', desc: '이슈와 프로젝트 일정을 관리합니다' },
  { id: 'asana', name: 'Asana', url: 'https://mcp.asana.com/sse', transport: 'sse', desc: '팀 과제와 일정을 관리합니다' },
  { id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', desc: '코딩 라이브러리의 최신 문서를 찾아봅니다', noLogin: true },
];

const cleanName = (name) => String(name || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

class Plugins {
  // run: claude CLI 실행 함수 (테스트에서 바꾼다)
  constructor(dataDir, { run = runBin } = {}) {
    this.file = path.join(dataDir, 'mcp.json');
    this.sharedFile = path.join(dataDir, 'plugins-added.json');
    this.run = run;
    this.cache = null;
    this.loading = null;
    this.logins = new Set();
  }

  catalog() { return CATALOG; }

  // DOMO 가 Claude 에 등록한 플러그인 이름 (브라우저 로그인이 필요한 서버는 Claude 설정에 등록해야 로그인할 수 있다)
  shared() {
    try { return JSON.parse(fs.readFileSync(this.sharedFile, 'utf8')); } catch { return []; }
  }

  // 브라우저 로그인 방식 플러그인: Claude 에 등록한다 (이 컴퓨터의 Claude Code 에서도 같이 보인다).
  async addShared({ name, url, transport }) {
    const key = cleanName(name);
    if (!key) throw bad('이름을 입력하세요.');
    if (!/^https:\/\//.test(url || '')) throw bad('URL은 https:// 로 시작해야 합니다.');
    const r = await this.run('claude', ['mcp', 'add', '--scope', 'user', '--transport', transport === 'sse' ? 'sse' : 'http', key, url], { timeout: 30_000 });
    if (r.err && !/already exists/i.test(`${r.stdout}${r.stderr}`)) throw bad(`추가하지 못했습니다. ${String(r.stderr || r.stdout || r.err.message).trim().slice(0, 200)}`);
    fs.writeFileSync(this.sharedFile, JSON.stringify([...new Set([...this.shared(), key])]));
    this.cache = null;
    return key;
  }

  // 브라우저에서 로그인한다 (claude 가 이 컴퓨터의 브라우저를 연다). 끝나면 상태를 다시 읽는다.
  login(name) {
    if (this.logins.has(name)) return;
    this.logins.add(name);
    this.run('claude', ['mcp', 'login', name], { timeout: LOGIN_TIMEOUT_MS }).then(() => {
      this.logins.delete(name);
      this.cache = null;
    });
  }

  async remove(name) {
    if (this.shared().includes(name)) {
      await this.run('claude', ['mcp', 'remove', '--scope', 'user', name], { timeout: 30_000 });
      fs.writeFileSync(this.sharedFile, JSON.stringify(this.shared().filter((n) => n !== name)));
      this.cache = null;
    } else this.removeCustom(name);
  }

  // 사이트에서 추가한 서버 (claude 전역 설정은 건드리지 않고 --mcp-config 로만 쓴다)
  custom() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).mcpServers || {}; } catch { return {}; }
  }

  saveCustom(servers) {
    fs.writeFileSync(this.file, JSON.stringify({ mcpServers: servers }, null, 1), { mode: 0o600 });
    this.cache = null;
  }

  addCustom({ name, url, command, args, token }) {
    const key = cleanName(name);
    if (!key) throw Object.assign(new Error('이름을 입력하세요.'), { status: 400 });
    const servers = this.custom();
    if (url) {
      if (!/^https?:\/\//.test(url)) throw Object.assign(new Error('URL은 http(s):// 로 시작해야 합니다.'), { status: 400 });
      servers[key] = { type: 'http', url };
      const t = String(token || '').trim();
      if (t) servers[key].headers = { Authorization: /^(bearer|basic) /i.test(t) ? t : `Bearer ${t}` };
    } else if (command) {
      servers[key] = { type: 'stdio', command, args: Array.isArray(args) ? args : String(args || '').split(' ').filter(Boolean) };
    } else {
      throw Object.assign(new Error('URL 또는 실행 명령이 필요합니다.'), { status: 400 });
    }
    this.saveCustom(servers);
    return key;
  }

  removeCustom(name) {
    const servers = this.custom();
    delete servers[name];
    this.saveCustom(servers);
  }

  mcpConfigPath() {
    return Object.keys(this.custom()).length ? this.file : null;
  }

  // `claude mcp list` 결과를 읽는다 (상태 확인에 몇 초 걸려서 캐시)
  async list({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.items;
    this.loading ||= new Promise((resolve) => {
      this.run('claude', ['mcp', 'list'], { timeout: 60_000, cwd: path.dirname(this.file) }).then(({ stdout }) => {
        const shared = this.shared();
        const items = [];
        for (const line of String(stdout || '').split('\n')) {
          const m = line.match(/^(.+?): (.+) - (✔|✗|!)\s*(.*)$/);
          if (!m) continue;
          const name = m[1].trim();
          items.push({
            name,
            tool: toolPrefix(name),
            target: m[2].trim(),
            status: m[3] === '✔' ? 'connected' : m[3] === '!' ? 'needs-auth' : 'failed',
            statusText: m[4].trim(),
            source: shared.includes(name) ? 'domo' : name.startsWith('claude.ai ') ? 'claude.ai' : name.startsWith('plugin:') ? 'plugin' : 'claude',
          });
        }
        for (const [name, cfg] of Object.entries(this.custom())) {
          if (!items.some((i) => i.name === name)) {
            items.push({ name, tool: toolPrefix(name), target: cfg.url || cfg.command, status: 'unknown', statusText: '', source: 'custom' });
          } else {
            items.find((i) => i.name === name).source = 'custom';
          }
        }
        for (const name of shared) if (!items.some((i) => i.name === name)) items.push({ name, tool: toolPrefix(name), target: '', status: 'unknown', statusText: '', source: 'domo' });
        this.cache = { at: Date.now(), items };
        this.loading = null;
        resolve(items);
      });
    });
    return this.loading;
  }
}

// Claude Code 의 MCP 도구 이름 규칙: mcp__<서버명(영숫자 외는 _)>__<도구>
function toolPrefix(name) { return `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_')}`; }

module.exports = { Plugins, toolPrefix };
