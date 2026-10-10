'use strict';
// AI 연결 상태: 이 DOMO가 돌고 있는 컴퓨터(내 Mac 또는 내 Codespace)의 공식 CLI에
// 사용자가 "본인 구독"으로 로그인했는지 확인한다. DOMO는 로그인 정보를 다루지 않는다.
const { runBin } = require('./bins');

const CACHE_MS = 30_000;
const run = (bin, args) => runBin(bin, args, { timeout: 15_000 });

async function claudeStatus(bin = 'claude') {
  const r = await run(bin, ['auth', 'status']);
  if (r.err?.code === 'ENOENT') return { installed: false, loggedIn: false };
  try {
    const j = JSON.parse(r.stdout);
    return {
      installed: true,
      loggedIn: !!j.loggedIn,
      method: j.authMethod || null, // claude.ai(구독) | console(API) 등
      plan: j.subscriptionType || null,
      account: j.email || null,
    };
  } catch {
    return { installed: true, loggedIn: false };
  }
}

async function codexStatus(bin = 'codex') {
  const r = await run(bin, ['login', 'status']);
  if (r.err?.code === 'ENOENT') return { installed: false, loggedIn: false };
  const text = `${r.stdout}\n${r.stderr}`;
  const loggedIn = !r.err && /logged in/i.test(text) && !/not logged in/i.test(text);
  return {
    installed: true,
    loggedIn,
    method: /chatgpt/i.test(text) ? 'chatgpt' : /api key/i.test(text) ? 'apikey' : null,
  };
}

class Connections {
  constructor({ claudeBin = 'claude', codexBin = 'codex', fake } = {}) {
    this.claudeBin = claudeBin;
    this.codexBin = codexBin;
    this.fake = fake; // 테스트용: { claude: {...}, codex: {...} }
    this.cache = null;
  }

  async status({ refresh = false } = {}) {
    if (this.fake) return this.fake;
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const [claude, codex] = await Promise.all([claudeStatus(this.claudeBin), codexStatus(this.codexBin)]);
    const value = { claude, codex, codespace: !!process.env.CODESPACES };
    this.cache = { at: Date.now(), value };
    return value;
  }

  invalidate() { this.cache = null; }
}

// 엔진 오류 메시지가 "로그인이 필요함"을 뜻하는지
function looksLikeLoginProblem(msg) {
  return /not logged in|please run \/?login|log ?in required|invalid api key|authentication|unauthori[sz]ed|401|oauth token/i.test(String(msg || ''));
}

module.exports = { Connections, looksLikeLoginProblem };
