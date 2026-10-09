'use strict';
// 각 AI 엔진을 "프로세스 하나 실행 → 답변 텍스트 + 세션 ID" 형태로 통일한다.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

class EngineError extends Error {
  constructor(message, { aborted = false, sessionProblem = false } = {}) {
    super(message);
    this.aborted = aborted;
    this.sessionProblem = sessionProblem;
  }
}

// 프로세스 그룹 단위로 실행해서, 중단 시 자식(도구 실행 등)까지 함께 종료한다.
function runProcess(cmd, args, { input = '', cwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS, onSpawn, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new EngineError('중단됨', { aborted: true }));
    let child;
    try {
      child = spawn(cmd, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      return reject(new EngineError(`${cmd} 실행 실패: ${err.message}`));
    }
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killReason = null;

    const kill = (reason) => {
      if (killReason) return;
      killReason = reason;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 이미 종료 */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 종료 */ } }, 3000).unref();
    };
    const onAbort = () => kill('abort');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => kill('timeout'), timeoutMs);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    let pending = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      // 실시간 진행 표시: 줄 단위 JSON 이벤트를 바로 넘긴다.
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const l of lines) if (l.trim()) { try { onLine(l); } catch { /* 표시용이라 무시 */ } }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(() => reject(new EngineError(
      err.code === 'ENOENT' ? `'${cmd}' 명령을 찾을 수 없습니다. 설치되어 있는지 확인하세요.` : err.message))));
    child.on('close', (code) => finish(() => {
      if (killReason === 'abort') return reject(new EngineError('중단됨', { aborted: true }));
      if (killReason === 'timeout') return reject(new EngineError(`응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`));
      resolve({ code, stdout, stderr, pid: child.pid });
    }));
    child.stdin.on('error', () => { /* 프로세스가 먼저 끝난 경우 */ });
    child.stdin.end(input);
  });
}

function lastLine(text) {
  return text.trim().split('\n').filter(Boolean).pop() || '';
}

function looksLikeSessionProblem(msg) {
  return /session|conversation|thread|not found|no such|resume/i.test(msg) && /not found|no .*found|invalid|could not|unable/i.test(msg);
}

// ── Claude Code ────────────────────────────────────────────────
// 엔진이 지금 하는 일을 사람이 읽을 수 있는 한 줄로 바꾼다.
function toolLabel(name, input = {}) {
  const base = (p) => String(p || '').split('/').pop();
  if (name === 'WebSearch') return `웹 검색 · ${input.query || ''}`;
  if (name === 'WebFetch') { try { return `페이지 읽는 중 · ${new URL(input.url).host}`; } catch { return '페이지 읽는 중'; } }
  if (name === 'Read') return `파일 읽는 중 · ${base(input.file_path)}`;
  if (name === 'Grep' || name === 'Glob') return `찾는 중 · ${input.pattern || ''}`;
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return `파일 수정 중 · ${base(input.file_path)}`;
  if (name === 'Bash') return `명령 실행 · ${String(input.command || '').slice(0, 40)}`;
  if (name === 'Skill') return `스킬 사용 · ${input.skill || input.name || ''}`;
  if (name === 'ToolSearch') return '도구 준비 중';
  const m = String(name).match(/^mcp__(?:claude_ai_)?([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (m) {
    const svc = { Figma: '피그마', Notion: '노션', Claude_Docs: '문서', Slack: '슬랙' }[m[1]] || m[1];
    return `${svc} · ${m[2].replace(/[-_]/g, ' ')}`;
  }
  return name;
}

async function claudeEngine({ prompt, sessionId, agent, cwd, signal, onSpawn, onEvent }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt', agent.systemPrompt];
  if (sessionId) args.push('--resume', sessionId);
  if (agent.model) args.push('--model', agent.model);
  if (agent.fallbackModel && agent.fallbackModel !== agent.model) args.push('--fallback-model', agent.fallbackModel);
  if (agent.effort) args.push('--effort', agent.effort);
  if (agent.noTools) args.push('--tools', '');
  if (agent.mcpConfig) args.push('--mcp-config', agent.mcpConfig);
  if (agent.allowedTools?.length) args.push('--allowedTools', agent.allowedTools.join(','));
  if (agent.disallowedTools?.length) args.push('--disallowedTools', agent.disallowedTools.join(','));

  const onLine = onEvent && ((line) => {
    const e = JSON.parse(line);
    if (e.type === 'stream_event') {
      const ev = e.event || {};
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') onEvent({ type: 'textStart' });
      else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') onEvent({ type: 'text', delta: ev.delta.text });
      else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') onEvent({ type: 'tool', label: '생각 중' });
    } else if (e.type === 'assistant') {
      for (const c of e.message?.content || []) if (c.type === 'tool_use') onEvent({ type: 'tool', label: toolLabel(c.name, c.input) });
    }
  });
  const r = await runProcess(agent.bin || 'claude', args, { input: prompt, cwd, signal, timeoutMs: agent.timeoutMs, onSpawn, onLine });
  let json;
  try {
    // stream-json: 여러 이벤트 줄 중 마지막 result 줄이 최종 답이다. (json 출력이면 마지막 줄 하나)
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const resultLine = [...lines].reverse().find((l) => l.includes('"type":"result"')) || lastLine(r.stdout);
    json = JSON.parse(resultLine);
  } catch {
    const msg = (r.stderr || r.stdout).trim().slice(0, 500) || `claude 종료 코드 ${r.code}`;
    throw new EngineError(msg, { sessionProblem: !!sessionId && looksLikeSessionProblem(msg) });
  }
  if (json.is_error || typeof json.result !== 'string') {
    const msg = String(json.result || json.error || json.subtype || '알 수 없는 오류').slice(0, 500);
    throw new EngineError(msg, { sessionProblem: !!sessionId && looksLikeSessionProblem(msg) });
  }
  return {
    text: json.result.trim(),
    sessionId: json.session_id || sessionId,
    meta: { costUsd: json.total_cost_usd, ms: json.duration_ms },
  };
}

// ── Codex CLI ──────────────────────────────────────────────────
async function codexEngine({ prompt, sessionId, agent, cwd, signal, onSpawn, onEvent, images = [] }) {
  const outFile = path.join(os.tmpdir(), `aitalk-codex-${crypto.randomUUID()}.txt`);
  const sandbox = agent.sandbox || 'read-only';
  const common = ['--json', '--skip-git-repo-check', '-o', outFile];
  if (agent.model) common.push('-m', agent.model);
  if (agent.effort) common.push('-c', `model_reasoning_effort="${agent.effort}"`);
  for (const img of images) common.push('-i', img);
  // Codex에는 시스템 프롬프트 옵션이 없으므로 새 세션의 첫 메시지에 역할을 넣는다.
  const input = sessionId ? prompt : `${agent.systemPrompt}\n\n${prompt}`;
  const args = sessionId
    ? ['exec', 'resume', ...common, '-c', `sandbox_mode="${sandbox}"`, sessionId, '-']
    : ['exec', ...common, '-s', sandbox, '-'];

  const started = Date.now();
  let r;
  try {
    const onLine = onEvent && ((line) => {
      const ev = JSON.parse(line);
      const it = ev.item || {};
      if (ev.type !== 'item.started') return;
      if (it.type === 'command_execution') onEvent({ type: 'tool', label: `명령 실행 · ${String(it.command || '').slice(0, 40)}` });
      else if (it.type === 'web_search') onEvent({ type: 'tool', label: `웹 검색 · ${it.query || ''}` });
      else if (it.type === 'mcp_tool_call') onEvent({ type: 'tool', label: `${it.server || ''} · ${it.tool || ''}` });
      else if (it.type === 'reasoning') onEvent({ type: 'tool', label: '생각 중' });
    });
    r = await runProcess(agent.bin || 'codex', args, { input, cwd, signal, timeoutMs: agent.timeoutMs, onSpawn, onLine });
  } catch (err) {
    fs.rm(outFile, { force: true }, () => {});
    throw err;
  }
  let threadId = sessionId;
  let text = '';
  const errors = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id;
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) text = ev.item.text;
    else if (ev.type === 'error' && ev.message) errors.push(ev.message);
    else if (ev.type === 'turn.failed' && ev.error?.message) errors.push(ev.error.message);
  }
  try {
    const fromFile = fs.readFileSync(outFile, 'utf8').trim();
    if (fromFile) text = fromFile;
  } catch { /* 파일 없음 */ }
  fs.rm(outFile, { force: true }, () => {});

  if (!text.trim()) {
    const msg = [...new Set(errors)].join(' / ') || r.stderr.trim().slice(-500) || `codex 종료 코드 ${r.code}`;
    throw new EngineError(msg, { sessionProblem: !!sessionId && looksLikeSessionProblem(msg) });
  }
  return { text: text.trim(), sessionId: threadId, meta: { ms: Date.now() - started } };
}

// ── Mock (비용 없는 테스트용) ──────────────────────────────────
// 실제 자식 프로세스를 띄워서 중단/타임아웃 경로까지 진짜처럼 검증한다.
const mockTurns = new Map();
const mockStrict = new Set(); // '#never-pass'를 본 세션은 계속 통과시키지 않는다
const mockLog = [];
async function mockEngine({ prompt, sessionId, agent, cwd, signal, onSpawn, onEvent, images = [] }) {
  mockLog.push({ agentId: agent.id, prompt, sessionId, agent, images });
  onEvent?.({ type: 'tool', label: '웹 검색 · mock' });
  const sid = sessionId || `mock-${agent.id}-${crypto.randomUUID().slice(0, 8)}`;
  const n = (mockTurns.get(sid) || 0) + 1;
  mockTurns.set(sid, n);

  let delay = agent.mockDelayMs ?? 50;
  if (prompt.includes('#slow')) delay = 60_000;
  let reply;
  const role = agent.role || '';
  const stage = prompt.match(/\[단계: ([^\]]+)\]/)?.[1];
  if (stage) {
    reply = mockStudio(stage, prompt, agent);
  } else if (role === 'curator') {
    // 기억 정리 테스트: '#remember 내용' 이 있으면 사용자 정보로 기억한다.
    const m = prompt.match(/#remember ([^\n#]+)/);
    const t = prompt.match(/#task ([^\n#]+)/);
    reply = JSON.stringify({
      user_add: m ? [m[1].trim()] : [],
      tasks_add: t ? [{ title: t[1].trim(), due: '2026-10-01', project: '테스트 프로젝트' }] : [],
      projects_upsert: t ? [{ name: '테스트 프로젝트', desc: '', status: '진행 중' }] : [],
      room_summary: '테스트 대화 요약',
      pattern: prompt.match(/#repeat-([a-z]+)/) ? { key: `${prompt.match(/#repeat-([a-z]+)/)[1]} 판넬 문구 다듬기`, name: `${prompt.match(/#repeat-([a-z]+)/)[1]} 문구 다듬기`, description: '판넬 문구를 다듬을 때', steps: ['초안 확인', '문체 적용', '두 가지 버전 제시'] } : null,
      changes: m || t ? '테스트 기억 추가' : '',
    });
  } else if (prompt.includes('배정 가능한 AI:')) {
    // 작업 계획: 배정 가능한 AI 중 앞의 두 명에게 일을 준다
    const pool = prompt.match(/배정 가능한 AI: ([^.\n]+)/)[1].split(', ').map((x) => x.replace(/\(.*\)$/, ''));
    reply = `목표: 테스트 목표\n완료 기준:\n- 결과물 1개\n배정:\n${pool.slice(0, 2).map((n) => `- ${n}: ${n}의 할 일`).join('\n')}`;
  } else if (prompt.includes('최종 보고를 쓰세요')) {
    reply = '## 결과\n테스트 결과물\n## 완료 기준\n- ✓ 결과물 1개\n## 남은 일\n- [ ] 결과 확인하기 (담당: 나)';
  } else if (prompt.includes('총괄이 당신에게 맡긴 일')) {
    reply = `[${agent.name}] 맡은 일 수행 완료`;
  } else if (prompt.includes('회의록을 작성')) {
    reply = '## 결론\n테스트 결론\n## 할 일\n- [ ] 회의에서 나온 할 일 (담당: 나, 기한: 2026-10-02)';
  } else if (prompt.includes('입장: 합의')) {
    reply = `${agent.name}의 회의 의견 ${n}\n입장: ${n >= 2 || prompt.includes('#agree') ? '합의' : '이견'}`;
  } else if (prompt.includes('#fail') && (prompt.includes('#fail-worker') ? !prompt.includes('판정: 통과') : prompt.includes('판정: 통과'))) {
    reply = null;
  } else if (prompt.includes('판정: 통과') && prompt.includes('#bare-pass')) {
    reply = '판정: 통과'; // 판정 한 줄만 쓰는 감사 AI
  } else if (prompt.includes('판정: 통과')) {
    if (prompt.includes('#never-pass')) mockStrict.add(sid);
    const strict = mockStrict.has(sid);
    reply = !strict && n >= 2 ? '확인했습니다. 문제 없습니다.\n판정: 통과' : `${n}번째 검토: 근거가 부족한 문장이 있습니다.\n판정: 수정필요`;
  } else {
    reply = `[${agent.name} 답변 ${n}] 받은 메시지 ${prompt.split('\n').filter((l) => l.includes(':')).length}줄을 확인했습니다.`;
  }
  if (prompt.includes('#nologin')) reply = null;
  const failText = prompt.includes('#nologin') ? 'Not logged in · Please run /login' : 'mock failure';
  const script = reply === null
    ? `setTimeout(()=>{process.stderr.write(${JSON.stringify(failText)});process.exit(2)},${delay})`
    : `setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify({ result: reply }))}),${delay})`;
  const r = await runProcess(process.execPath, ['-e', script], { cwd, signal, timeoutMs: agent.timeoutMs, onSpawn });
  if (r.code !== 0) throw new EngineError(r.stderr || 'mock 오류');
  return { text: JSON.parse(r.stdout).result, sessionId: sid, meta: { ms: delay } };
}

// 스튜디오 단계별 mock 응답. 요청에 #실행 / #학습 이 있으면 그 유형으로 분류한다.
function mockStudio(stage, prompt, agent) {
  switch (stage) {
    case '브리프':
      if (prompt.includes('#실행')) return '유형: 실행형';
      if (prompt.includes('#학습')) return '유형: 학습형';
      return '유형: 사고형\n제목: 테스트 프로젝트\n목표: 테스트 목표\n산출물: 판넬 1장\n완료 기준:\n- 판넬 1장\n질문:\n1. 1차 가설은?';
    case '설명': return `[${agent.name}] 개념 설명\n이해한 내용을 한두 문장으로 다시 말해 보세요.`;
    case '팩트시트': return '| # | 사실 | 라벨 | 출처 |\n|1|사실|측정|매체 2026-10-01|';
    case '방향안': return '### A안 · 확장\n- 컨셉: a\n### B안 · 반박\n- 컨셉: b\n### C안 · 와일드\n- 컨셉: c';
    case '채점표': return '| 기준 | A | B | C |\n### 추천: B';
    case '사실 검증': return '사실 문제 없음';
    case '결정 카드': return '### A · 확장 — a\n### B · 반박 — b\n### C · 와일드 — c\n**팀 추천: B**';
    case '시안': return `[${agent.name}] 시안 1 제작`;
    case '시안 크리틱': return '✓ 좋음 / ✗ 고칠 것 1개';
    case '완료 기준 검증': return '✓ 판넬 1장';
    case '수정본': return `[${agent.name}] 수정본 https://www.figma.com/design/test`;
    case '확정': return '확정본 게시 완료';
    case '프로젝트 보고': return '## 결과\n확정본\n## 결정 기록\n- 가설 → B\n## 남은 일\n- [ ] 확정본 확인하기 (담당: 나)';
    case '기준 학습': {
      const reply = prompt.split('[사용자 답]\n')[1]?.split('\n')[0] || '';
      return JSON.stringify({ add: reply.length >= 4 ? [`기준: ${reply.slice(0, 20)}`] : [] });
    }
    default: return `[${agent.name}] ${stage}`;
  }
}

const engines = { claude: claudeEngine, codex: codexEngine, mock: mockEngine };

module.exports = { engines, runProcess, EngineError, mockLog, toolLabel };
