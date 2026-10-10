'use strict';
// 플러그인 = Claude Code 의 MCP 서버. claude.ai 연결(노션·피그마 등) + 사이트에서 직접 추가한 서버.
const fs = require('node:fs');
const path = require('node:path');
const { runBin } = require('./bins');

const CACHE_MS = 10 * 60 * 1000;

class Plugins {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'mcp.json');
    this.cache = null;
    this.loading = null;
  }

  // 사이트에서 추가한 서버 (claude 전역 설정은 건드리지 않고 --mcp-config 로만 쓴다)
  custom() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).mcpServers || {}; } catch { return {}; }
  }

  saveCustom(servers) {
    fs.writeFileSync(this.file, JSON.stringify({ mcpServers: servers }, null, 1));
    this.cache = null;
  }

  addCustom({ name, url, command, args }) {
    const key = String(name || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    if (!key) throw Object.assign(new Error('이름을 입력하세요.'), { status: 400 });
    const servers = this.custom();
    if (url) {
      if (!/^https?:\/\//.test(url)) throw Object.assign(new Error('URL은 http(s):// 로 시작해야 합니다.'), { status: 400 });
      servers[key] = { type: 'http', url };
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
      runBin('claude', ['mcp', 'list'], { timeout: 60_000, cwd: path.dirname(this.file) }).then(({ stdout }) => {
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
            source: name.startsWith('claude.ai ') ? 'claude.ai' : name.startsWith('plugin:') ? 'plugin' : 'claude',
          });
        }
        for (const [name, cfg] of Object.entries(this.custom())) {
          if (!items.some((i) => i.name === name)) {
            items.push({ name, tool: toolPrefix(name), target: cfg.url || cfg.command, status: 'unknown', statusText: '', source: 'custom' });
          } else {
            items.find((i) => i.name === name).source = 'custom';
          }
        }
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
