'use strict';
// 대화방 진행자.
//  · 회의(meeting): 의장이 안건을 열고 → 참석 AI들이 돌아가며 토론 → 모두 합의하거나 최대 라운드 → 의장이 회의록·할 일 정리
//  · 검토(review):  작업 AI → 감사 AI → (수정필요면) 작업 AI … 통과/최대 라운드까지
//  · 작업(work):    총괄이 목표·완료 기준·배정을 정함 → 배정된 AI만 실행 → 감사가 완료 기준만 확인 → (막는 문제만) 수정 → 총괄 최종 보고
//  · 스튜디오(studio): 요청 분류 → 사고형은 브리프·발산·크리틱·시안 사이에 사용자 컨펌 3번 (src/studio.js)
//  · 1:1(chat):     한 AI가 답한다
// 루프 방지: 범위 확장 금지, 2라운드부터는 이견 있는 AI만 발언, 감사는 지난 지적 확인만, 과반 합의 시 종료.
// 대화가 끝나면 기억 정리 AI가 내 정보·프로젝트·과제를 장기 기억에 반영한다.
const { PERSONALITIES, PERMISSIONS, MODELS, STUDIO_ROLES, PERSONA_TEMPLATES, soulFor } = require('./profiles');
const { localDate } = require('./scheduler');
const studio = require('./studio');
const team = require('./team');
const critique = require('./critique');

// 팀 작업의 호출 1회 제한 시간. 넘기면 실패로 보고 대신 맡을 AI 에게 넘긴다.
const TEAM_TIMEOUT_MS = 5 * 60 * 1000;
const { looksLikeLoginProblem } = require('./connections');

const VERDICT_RE = /^\s*[*_`]*\s*판정\s*[:：]\s*[*_`]*\s*(통과|수정\s*필요)\s*[*_`.]*\s*$/m;
const STANCE_RE = /^\s*[*_`]*\s*입장\s*[:：]\s*[*_`]*\s*(합의|이견)\s*[*_`.]*\s*$/m;
const VERDICT_LINE = '마지막 줄에는 반드시 "판정: 통과" 또는 "판정: 수정필요" 중 하나만 쓰세요.';
const TASK_RE = /^\s*[-*]\s*\[\s?\]\s*(.+?)\s*$/gm;
const HISTORY_LIMIT = 60;
const MODES = ['studio', 'work', 'meeting', 'review', 'chat'];
const ASSIGN_RE = /^\s*[-*•]?\s*@?([^:：\n]{1,20}?)\s*[:：]\s*(.+)$/;

class Orchestrator {
  constructor({ store, profiles, memory, plugins, engines, bus, workspace, evals = null, skills = null, connections = null, critiques = null, examples = null, now = () => new Date() }) {
    this.connections = connections;
    this.critiques = critiques;
    this.examples = examples;
    this.evals = evals;
    this.skills = skills;
    this.store = store;
    this.profiles = profiles;
    this.memory = memory;
    this.plugins = plugins;
    this.engines = engines;
    this.bus = bus;
    this.workspace = workspace;
    this.now = now;
    this.running = new Map(); // roomId → { controller, children:Set }
    this.curating = new Map(); // roomId → Promise
  }

  get agents() { return this.profiles.map(); }
  isRunning(roomId) { return this.running.has(roomId); }

  post(roomId, sender, text, meta) {
    const msg = this.store.addMessage(roomId, { sender, text, meta });
    this.bus.emit('message', msg);
    return msg;
  }

  userMessage(roomId, text, meta) {
    const msg = this.post(roomId, 'user', text, meta);
    // Claude 앱처럼: "새 채팅"은 첫 메시지로 제목을 정한다.
    const room = this.store.getRoom(roomId);
    if (room && room.name === '새 채팅' && this.store.messages(roomId).filter((m) => m.sender === 'user').length === 1) {
      const firstLine = team.stripCommand(text).replace(/(용도|단계)\s*[:：]\s*\S+\s*/g, '').split('\n').map((l) => l.trim()).find(Boolean) || '';
      const title = firstLine || team.COMMANDS[team.commandOf(text)]?.label || '새 채팅';
      this.store.updateRoom(roomId, { name: title.slice(0, 30) });
      this.bus.emit('rooms', {});
    }
    if (!this.isRunning(roomId)) this.run(roomId, this.aiText(msg));
    return msg;
  }

  // AI가 읽는 메시지 본문: 답장 대상과 첨부 파일 경로를 본문 뒤에 붙인다 (앞에 붙이면 "컨펌", "/중단" 인식이 깨진다).
  aiText(m) {
    let t = m.text;
    if (m.meta?.reply) t += `\n(↪ ${this.senderLabel(m.meta.reply.sender)}의 "${m.meta.reply.excerpt}"에 대한 답)`;
    if (m.meta?.files?.length) t += `\n[첨부 파일 — Read 도구로 직접 열어 확인할 것]\n${m.meta.files.map((f) => `- ${f.name}: ${f.path}`).join('\n')}`;
    return t;
  }

  stop(roomId) {
    const job = this.running.get(roomId);
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  mentioned(room, text) {
    const ids = room.members.filter((id) => {
      const a = this.agents[id];
      return a && (text.includes(`@${a.name}`) || text.toLowerCase().includes(`@${a.id.toLowerCase()}`));
    });
    return ids.length ? ids : null;
  }

  // "/회의 안건", "/검토 요청" 으로 이번 메시지만 모드를 바꿀 수 있다.
  modeFor(room, text) {
    if (/^\s*\/회의/.test(text)) return 'meeting';
    if (/^\s*\/검토/.test(text)) return 'review';
    if (/^\s*\/(작업|바로)/.test(text)) return 'work';
    if (/^\s*\/스튜디오/.test(text)) return 'studio';
    // 스튜디오 프로젝트가 내 답을 기다리는 중이면 어떤 모드든 이어서 진행한다.
    if (room.project?.awaiting) return 'studio';
    if (room.members.length < 2) return 'chat';
    return MODES.includes(room.mode) ? room.mode : 'review';
  }

  async run(roomId, triggerText = '') {
    const room = this.store.getRoom(roomId);
    if (!room || this.running.has(roomId)) return;
    const members = room.members.filter((id) => this.agents[id]);
    if (!members.length) {
      this.post(roomId, 'system', '이 대화방에 참여 중인 AI 프로필이 없습니다. 방 정보에서 AI를 추가하세요.', { kind: 'error' });
      return;
    }

    const job = { controller: new AbortController(), children: new Set() };
    this.running.set(roomId, job);
    this.bus.emit('status', { roomId, running: true });
    let aborted = false;
    try {
      const only = this.mentioned(room, triggerText);
      const cmd = only ? null : team.commandOf(triggerText);
      const mode = only ? 'chat' : this.modeFor({ ...room, members }, triggerText);
      // 기본은 AI 1명. 1:1 채팅에서도 팀 서비스·스튜디오를 부르면 프로필 전체에서 역할별로 팀을 꾸린다.
      const crew = members.length > 1 ? members : this.teamIds();
      if (room.critique?.awaiting && !cmd && !only) await this.resumeCritique(room, crew, job, triggerText);
      else if (cmd) await this.teamService(cmd, room, crew, job, triggerText);
      else if (mode === 'studio' && crew.length > 1) await this.studioLoop(room, crew, job, triggerText);
      else if (mode === 'work' && members.length > 1) await this.workLoop(room, members, job);
      else if (mode === 'meeting' && members.length > 1) await this.meetingLoop(room, members, job);
      else if (mode === 'review' && members.length > 1) await this.reviewLoop(room, members, job);
      else {
        for (const id of only || members.slice(0, 1)) {
          if (!(await this.turn(room, this.agents[id], job, { phase: 'chat' }))) break;
        }
      }
    } catch (err) {
      if (err.aborted) aborted = true;
      else this.post(roomId, 'system', `진행 중 오류: ${err.message}`, { kind: 'error' });
    } finally {
      this.running.delete(roomId);
      this.bus.emit('status', { roomId, running: false });
    }
    if (aborted) {
      this.post(roomId, 'system', '중단했습니다.', { kind: 'stopped' });
      return;
    }
    const msgs = this.store.messages(roomId);
    const last = msgs[msgs.length - 1];
    if (last?.sender === 'user' && this.store.getRoom(roomId)) { this.run(roomId, this.aiText(last)); return; }
    this.curate(roomId);
  }


  // AI 응답 실패를 대화에 남긴다. 로그인 문제면 화면이 "AI 연결" 안내 카드를 띄운다.
  fail(room, agent, err) {
    const needsLogin = looksLikeLoginProblem(err.message) || /명령을 찾을 수 없습니다/.test(err.message);
    this.post(room.id, 'system', needsLogin
      ? `${agent.name}: ${agent.engine === 'codex' ? 'Codex' : 'Claude'}에 로그인되어 있지 않습니다. 설정 → AI 연결에서 본인 계정으로 로그인하세요.`
      : `${agent.name} 응답 실패: ${err.message}`, { kind: 'error', agentId: agent.id, needsLogin, engine: agent.engine });
  }

  // ── 팀 서비스 (src/team.js) ─────────────────
  teamIds() { return this.profiles.agents().map((a) => a.id); }

  // 대화에 바로 올리지 않고 답만 받는다 (병렬 실행용). 실패하면 오류를 남기고 null.
  // 팀 작업용 실행 설정: 가볍게 부르고(등록된 MCP·스킬 설명을 싣지 않음), 모델을 정하지 않은 Claude 는 팀 기본 모델을 쓴다.
  teamAgent(agent, room, { model = null, tools = null, noTools = false } = {}) {
    const rt = this.runtimeAgent(agent, room);
    const perm = PERMISSIONS[agent.permission] || PERMISSIONS.read;
    const pick = model || rt.model || (agent.engine === 'claude' ? this.profiles.settings.teamModel : '') || '';
    return { ...rt, model: pick, lean: true, noTools, tools: tools || perm.claude.allow, timeoutMs: rt.timeoutMs || TEAM_TIMEOUT_MS };
  }

  async ask(room, agent, job, prompt, { model = null, images = null, tools = null, noTools = false } = {}) {
    const signal = job.controller.signal;
    if (signal.aborted) throw Object.assign(new Error('중단됨'), { aborted: true });
    const engine = this.engines[agent.engine];
    if (!engine) return null;
    this.bus.emit('typing', { roomId: room.id, agentId: agent.id, on: true });
    const t0 = Date.now();
    try {
      const res = await engine({
        prompt, sessionId: null, agent: this.teamAgent(agent, room, { model, tools, noTools }), cwd: this.workspace, signal,
        onEvent: this.activity(room, agent), images: images || this.imagesFor(room),
        onSpawn: (child) => { job.children.add(child.pid); child.on('close', () => job.children.delete(child.pid)); },
      });
      res.meta = { ...(res.meta || {}), ms: res.meta?.ms || Date.now() - t0 };
      return res;
    } catch (err) {
      if (err.aborted) throw err;
      this.fail(room, agent, err);
      return null;
    } finally {
      this.bus.emit('typing', { roomId: room.id, agentId: agent.id, on: false });
    }
  }

  teamMeta(agent, res, extra) {
    return { ...(res?.meta || {}), model: agent.model || '', ...extra };
  }

  // 검증 결과의 판정 줄을 떼어 낸다
  splitVerdict(text) {
    const m = String(text || '').match(VERDICT_RE);
    const verdict = m ? (m[1] === '통과' ? 'pass' : 'revise') : null;
    const body = (m ? text.replace(VERDICT_RE, '') : String(text || '')).trim() || (verdict === 'pass' ? '문제 없음' : '확인이 필요합니다.');
    return { verdict, body };
  }

  // 연결(로그인)된 AI 인지 알려 주는 함수를 만든다. 연결 상태를 모르는 엔진(테스트용 등)은 쓸 수 있다고 본다.
  async readyCheck({ wait = true } = {}) {
    const st = wait ? await this.connections?.status().catch(() => null) : this.connections?.peek(() => this.bus.emit('agents', {}));
    return (a) => !!a && (!st?.[a.engine] || !!st[a.engine].loggedIn);
  }

  // 팀 서비스에서 누가 무엇을 맡는지. 연결되지 않은 AI 는 빼고, 검증을 맡을 다른 AI 가 없으면 verifier 는 null 이다.
  cast(crew, primaryId, ready) {
    const R = this.roles(crew);
    const A = (id) => (id && ready(this.agents[id]) ? this.agents[id] : null);
    const primary = A(primaryId) || A(R.producer) || A(R.pm) || this.agents[primaryId] || this.agents[R.pm];
    const codex = Object.values(this.agents).find((a) => a.engine === 'codex' && ready(a)) || null;
    const researcher = A(R.research) || primary;
    const verifier = A(R.verifier) || codex;
    return { R, A, primary, codex, researcher, verifier: verifier && verifier.id !== researcher.id ? verifier : null, verifierAny: verifier };
  }

  // 검증을 건너뛰는 이유 (결과물에 그대로 찍는다)
  skipReason(crew) {
    const v = this.agents[this.roles(crew).verifier] || Object.values(this.agents).find((a) => a.engine === 'codex');
    return v?.engine === 'codex' ? 'Codex 미연결' : '검증을 맡을 다른 AI 없음';
  }

  // 팀 서비스를 시작하기 전에 보여 줄 예상: AI 몇 명이 몇 번 호출되고 어떤 모델을 쓰는지.
  async teamPlan() {
    const ready = await this.readyCheck({ wait: false });
    const crew = this.teamIds();
    const primaryId = this.profiles.settings.primaryAgent || crew[0];
    const c = this.cast(crew, primaryId, ready);
    const skip = this.skipReason(crew);
    const modelOf = (a) => MODELS[a.engine]?.find((m) => m.id === (a.model || ''))?.label.replace('기본값', a.engine === 'codex' ? 'Codex 기본 모델' : 'Claude 기본 모델') || a.model;
    const plan = (list, extra = {}) => {
      const agents = list.filter(Boolean);
      const uniq = [...new Map(agents.map((a) => [a.id, a])).values()];
      return { calls: agents.length, agents: uniq.length, models: [...new Set(uniq.map(modelOf))], ...extra };
    };
    const lead = c.A(c.R.pm) || c.primary;
    const critic = c.A(c.R.critic);
    const concept = c.A(c.R.concept);
    const second = c.codex && c.codex.id !== c.primary.id ? c.codex : Object.values(this.agents).find((a) => a.id !== c.primary.id && ready(a)) || c.primary;
    const joiner = (critic || lead).id !== c.primary.id ? (critic || lead) : c.primary;
    return {
      // 읽기 확인 1 → (내 확인) → 시점 3 → 검증 1 → 위치 지정 1 → 종합 1
      critique: plan([lead, critic || c.primary, concept || critic || c.primary, c.codex || critic || c.primary, c.verifierAny || c.primary, lead, lead], { note: '읽기 확인 뒤 내 확인을 기다립니다' }),
      research: plan([c.researcher, c.verifier, lead], c.verifier ? {} : { note: `교차 검증 생략 (${skip})` }),
      verify: plan([c.verifierAny || c.primary], c.verifierAny ? {} : { note: `${skip} · 같은 회사 모델이 대신 확인` }),
      compare: plan([c.primary, c.primary, second, joiner]),
      // 가설 질문 → 발산 2 → 채점 2 → 결정 카드 → 시안 → 검토 2 → 정리. 고칠 때마다 2회쯤 더 든다.
      concept: plan([lead, c.researcher, concept || lead, critic, c.A(c.R.verifier), lead, c.A(c.R.producer) || c.primary, critic, c.A(c.R.verifier), lead], { approx: true, note: '끝까지 진행할 때 기준 · 수정 요청마다 2회쯤 추가' }),
    };
  }

  async teamService(cmd, room, crew, job, text) {
    const ready = await this.readyCheck();
    const { R, A, primary, codex, researcher, verifier, verifierAny } = this.cast(crew, room.members[0], ready);
    const skip = this.skipReason(crew);
    const request = team.stripCommand(text);
    const principles = this.memory.principlesText ? this.memory.principlesText() : '';
    const lastUser = [...this.store.messages(room.id)].reverse().find((m) => m.sender === 'user');
    const files = lastUser?.meta?.files?.length ? lastUser.meta.files.map((f) => `- ${f.name}: ${f.path}`).join('\n') : '';

    if (cmd === 'concept') return this.studioLoop(room, crew, job, `/스튜디오 ${request}`);

    if (cmd === 'critique') return this.startCritique(room, crew, job, text, lastUser);

    if (cmd === 'research') {
      this.post(room.id, 'system', verifier
        ? `데스크리서치 · ${researcher.name}가 조사하고 ${verifier.name}가 교차 검증합니다`
        : `데스크리서치 · ${researcher.name}가 조사합니다 · 교차 검증은 생략됩니다 (${skip})`, { kind: 'stage', team: 'research' });
      const facts = await this.ask(room, researcher, job, team.prompts.facts({ request, principles, about: this.memory.aboutText?.() || '' }));
      if (!facts) return;
      this.post(room.id, researcher.id, facts.text, this.teamMeta(researcher, facts, { team: 'research', label: verifier ? '팩트시트' : `팩트시트 · 검증 생략됨(${skip})`, unverified: !verifier }));
      let check = '';
      if (!verifier) {
        this.post(room.id, 'system', `교차 검증 생략됨 (${skip}) · 위 팩트시트는 다른 AI가 확인하지 않았습니다.${skip === 'Codex 미연결' ? ' 설정 → AI 연결에서 ChatGPT를 연결하면 다음부터 교차 검증합니다.' : ''}`, { kind: 'limit', team: 'research' });
      } else {
        const chk = await this.ask(room, verifier, job, team.prompts.crosscheck({ request, facts: facts.text }));
        if (chk) {
          const { verdict, body } = this.splitVerdict(chk.text);
          check = body;
          this.post(room.id, verifier.id, body, this.teamMeta(verifier, chk, { team: 'research', label: '교차 검증', verdict: verdict || 'revise' }));
        }
      }
      // 마무리: 조사와 검증을 한데 모아 요약하고, 다음에 이어갈 작업을 버튼으로 건넨다.
      const lead = A(R.pm) || primary;
      const wrap = await this.ask(room, lead, job, team.prompts.wrap({ request, facts: facts.text, check, about: this.memory.aboutText?.() || '', principles, unverified: !verifier }));
      if (!wrap) return;
      const { body: summary, next } = team.parseNext(wrap.text, request);
      this.post(room.id, lead.id, summary, this.teamMeta(lead, wrap, { team: 'research', label: verifier ? '리서치 정리' : '리서치 정리 · 검증 전', next }));
      return;
    }

    if (cmd === 'verify') {
      const target = [...this.store.messages(room.id)].reverse().find((m) => m.sender !== 'user' && m.sender !== 'system' && m.meta?.kind !== 'compare');
      if (!target) { this.post(room.id, 'system', '검증할 AI 답이 아직 없습니다. 먼저 질문해 주세요.', { kind: 'limit' }); return; }
      const question = [...this.store.messages(room.id)].reverse().find((m) => m.sender === 'user' && m.id < target.id)?.text || '';
      const checker = verifierAny || primary;
      if (!verifierAny) this.post(room.id, 'system', `사실 검증 · ${skip}이라 ${checker.name}가 대신 확인합니다. 같은 회사 모델이라 독립 검증은 아닙니다.`, { kind: 'stage', team: 'verify' });
      const res = await this.ask(room, checker, job, team.prompts.verify({ question, answer: target.text }));
      if (!res) return;
      const { verdict, body } = this.splitVerdict(res.text);
      this.post(room.id, checker.id, body, this.teamMeta(checker, res, { team: 'verify', label: verifierAny ? '사실 검증' : '사실 검증 · 같은 회사 모델', verdict: verdict || 'revise', replyTo: target.id }));
      return;
    }

    if (cmd === 'compare') return this.compare(room, primary, codex, A(R.critic) || A(R.pm), job, request);
  }

  // ── 크리틱 리허설 (src/critique.js) ─────────────────
  // ① 읽기 확인 → 사용자 수정 → ② 시점별 크리틱 ×3 → ③ 검증 → ④ 위치 지정 → ⑤ 종합. 호출마다 비용을 기록한다.
  stepModel(step, agent) {
    const id = this.profiles.settings.critiqueModels?.[step];
    return id && MODELS[agent.engine]?.some((m) => m.id === id) ? id : null;
  }

  // fallback: 맡은 AI 가 답하지 못하면(다른 회사 모델의 설정 문제 등) 대신 맡을 AI
  async askStep(room, agent, job, C, step, prompt, fallback = null) {
    let model = this.stepModel(step, agent);
    // 크리틱은 장표를 읽기만 하면 된다. 종합은 글만 받으므로 도구가 필요 없다.
    const lean = step === 'synth' ? { noTools: true } : { tools: ['Read'] };
    let res = await this.ask(room, agent, job, prompt, { model, ...lean, images: C.slides.filter((x) => x.image).map((x) => x.path) });
    if (!res && fallback && fallback.id !== agent.id) {
      this.post(room.id, 'system', `${agent.name}가 답하지 못해 ${fallback.name}가 대신 ${critique.STEP_LABEL[step]}을 맡습니다`, { kind: 'stage', team: 'critique' });
      agent = fallback;
      model = this.stepModel(step, agent);
      res = await this.ask(room, agent, job, prompt, { model, ...lean, images: C.slides.filter((x) => x.image).map((x) => x.path) });
    }
    if (res) {
      this.critiques.logCall(C.id, {
        step, agentId: agent.id, engine: agent.engine, model: model || agent.model || (agent.engine === 'claude' ? this.profiles.settings.teamModel : '') || '',
        ms: res.meta?.ms || 0, costUsd: res.meta?.costUsd || 0, tokensIn: res.meta?.tokensIn || 0, tokensOut: res.meta?.tokensOut || 0,
      });
    }
    return res;
  }

  async startCritique(room, crew, job, text, lastUser) {
    if (!this.critiques) return;
    const ready = await this.readyCheck();
    const { R, A, primary } = this.cast(crew, room.members[0], ready);
    const opt = critique.parseOptions(text);
    const m = lastUser?.meta?.critique || {};
    const purpose = critique.PURPOSES[m.purpose] ? m.purpose : opt.purpose;
    const stage = critique.STAGES[m.stage] ? m.stage : opt.stage;
    // 장표: 시작 시트가 번호·좌표축을 붙여 보낸 것을 쓰고, 없으면 첨부 순서대로 번호를 매긴다.
    const slides = m.slides?.length ? m.slides
      : (lastUser?.meta?.files || []).filter((f) => f.image || f.type === 'application/pdf').map((f, i) => ({ n: i + 1, fileId: f.id, path: f.path, url: f.url, name: f.name, image: f.image, axis: false }));
    const C = this.critiques.create({
      roomId: room.id, purpose, stage, request: opt.request, input: m, slides,
      principles: this.memory.principlesText ? this.memory.principlesText() : '',
      consent: !!this.profiles.settings.dataConsent, person: { name: this.profiles.user.name },
    });
    room.critique = { id: C.id, awaiting: null };
    const lead = A(R.pm) || primary;
    this.post(room.id, 'system', `크리틱 리허설 · ${critique.PURPOSES[purpose].label} · ${critique.STAGES[stage].label} 단계 · 먼저 ${lead.name}가 결과물을 어떻게 읽었는지 보여 드립니다`, { kind: 'stage', team: 'critique' });
    const res = await this.askStep(room, lead, job, C, 'read', critique.prompts.read(C));
    if (!res) { room.critique = null; this.critiques.update(C.id, { status: 'failed' }); this.saveProject(room); return; }
    const ai = critique.parseRead(res.text, slides);
    this.critiques.update(C.id, { status: 'confirm', read: { ai, final: null, confirmedFacts: [], edited: false } });
    room.critique.awaiting = 'read';
    this.saveProject(room);
    this.post(room.id, 'system', '제가 이해한 내용이 맞는지 확인해 주세요. 틀린 곳을 고치고, 직접 확인한 사실이 있으면 적어 주세요.', { kind: 'critique-read', critiqueId: C.id });
  }

  // 화면의 읽기 확인 카드에서 "크리틱 시작"을 눌렀을 때
  confirmCritique(roomId, id, body = {}) {
    const room = this.store.getRoom(roomId);
    const C = this.critiques?.get(id);
    if (!room || !C || room.critique?.id !== id || room.critique.awaiting !== 'read') return { error: '확인을 기다리는 크리틱이 아닙니다.', status: 409 };
    if (this.isRunning(roomId)) return { error: '진행 중입니다. 잠시 후 다시 시도해 주세요.', status: 409 };
    const final = critique.cleanRead(body.read, C.read.ai);
    const confirmedFacts = critique.linesOf(body.confirmedFacts);
    const edited = JSON.stringify(final) !== JSON.stringify({ ...C.read.ai, raw: undefined });
    this.critiques.update(id, { read: { ...C.read, final, confirmedFacts, edited } });
    const note = [edited ? '이해 요약을 고침' : '', confirmedFacts.length ? `직접 확인한 사실 ${confirmedFacts.length}개` : ''].filter(Boolean).join(' · ');
    return { message: this.userMessage(roomId, `읽기 확인 완료${note ? ` · ${note}` : ''}`, { critiqueConfirm: id }) };
  }

  async resumeCritique(room, crew, job, text) {
    const C = this.critiques?.get(room.critique.id);
    const closeWith = (msg) => { room.critique = null; this.saveProject(room); if (msg) this.post(room.id, 'system', msg, { kind: 'stopped' }); };
    if (!C) return closeWith('');
    if (studio.CANCEL_RE.test(text)) { this.critiques.update(C.id, { status: 'cancelled' }); return closeWith('크리틱을 닫았습니다.'); }
    const lastUser = [...this.store.messages(room.id)].reverse().find((x) => x.sender === 'user');
    // 카드 대신 글로 답한 경우: "그대로"면 그대로, 아니면 적은 줄을 직접 확인한 사실로 받는다.
    if (lastUser?.meta?.critiqueConfirm !== C.id) {
      const plain = String(lastUser?.text || '').trim();
      const asIs = /^(그대로|맞아|맞음|확인|시작|패스|ok|okay|네|응)\b/i.test(plain);
      this.critiques.update(C.id, { read: { ...C.read, final: C.read.ai, confirmedFacts: asIs ? [] : critique.linesOf(plain), edited: false } });
    }
    room.critique.awaiting = null;
    this.saveProject(room);
    await this.runCritique(room, crew, job, this.critiques.get(C.id));
  }

  async runCritique(room, crew, job, C) {
    const ready = await this.readyCheck();
    const { R, A, primary, codex, verifierAny } = this.cast(crew, room.members[0], ready);
    const P = critique.PURPOSES[C.purpose];
    const stage = critique.STAGES[C.stage];
    const lead = A(R.pm) || primary;
    // 시점마다 다른 팀원 (가능하면 디테일은 다른 회사 모델) · 서로의 결과를 보지 않는다
    const who = [A(R.critic) || primary, A(R.concept) || A(R.critic) || primary, codex || A(R.critic) || primary];
    const tags = { ...C.input, purpose: C.purpose, stage: C.stage };
    const examples = this.examples?.pick(tags) || [];
    this.critiques.update(C.id, { status: 'running', exampleCount: examples.length });
    this.post(room.id, 'system', `시점별 크리틱 · ${P.lenses.map((l, i) => `${l.label}(${who[i].name})`).join(' · ')}이 서로를 보지 않고 봅니다`, { kind: 'stage', team: 'critique' });
    const done = await Promise.all(P.lenses.map(async (lens, i) => {
      const res = await this.askStep(room, who[i], job, C, 'lens', critique.prompts.lens(C, lens, examples), A(R.critic) || primary);
      return res ? { lens, agent: who[i], ...critique.parseLens(res.text, lens, { scores: stage.scores }) } : null;
    }));
    const ok = done.filter(Boolean);
    if (!ok.length) { this.critiques.update(C.id, { status: 'failed' }); room.critique = null; this.saveProject(room); return; }
    const issues = ok.flatMap((l) => l.issues);
    const questions = ok.flatMap((l) => l.questions.map((q) => ({ viewpoint: l.lens.label, text: q })));
    const raw = ok.filter((l) => l.raw).map((l) => ({ label: l.lens.label, text: l.raw }));
    const table = stage.scores ? critique.scoreTable(ok.map((l) => ({ label: l.lens.label, scores: l.scores })), C.purpose) : null;
    C = this.critiques.update(C.id, { lenses: ok.map((l) => ({ id: l.lens.id, label: l.lens.label, agentId: l.agent.id, scores: l.scores })), issues, questions, raw, table });

    // 검증: 의견이 아니라 숫자·일관성·체크리스트만
    const checker = verifierAny || primary;
    this.post(room.id, 'system', `검증 · ${checker.name}가 숫자·장표 간 일관성${P.checklist.length ? `·${P.label} 체크리스트` : ''}를 확인합니다`, { kind: 'stage', team: 'critique' });
    const auto = critique.autoChecks(C.purpose, C.slides);
    const chk = await this.askStep(room, checker, job, C, 'check', critique.prompts.check(C, auto), primary);
    const checks = [...auto, ...(chk ? critique.parseCheck(chk.text) : [])];
    C = this.critiques.update(C.id, { checks, checkSkipped: !chk });

    // 위치 지정: 지적 글에 장표 번호와 영역만 붙인다
    if (C.slides.length && issues.length) {
      const loc = await this.askStep(room, lead, job, C, 'locate', critique.prompts.locate(C, issues));
      const map = loc ? critique.parseLocate(loc.text, C.slides.length) : {};
      for (const x of issues) if (map[x.id]) x.location = { ...x.location, ...map[x.id] };
      C = this.critiques.update(C.id, { issues });
    }

    const syn = await this.askStep(room, lead, job, C, 'synth', critique.prompts.synth(C, { issues, checks, table: table ? critique.tableText(table) : '' }));
    const synth = syn ? critique.parseSynth(syn.text) : { summary: '', top3: [], qa: [] };
    if (synth.raw) raw.push({ label: '종합', text: synth.raw });
    C = this.critiques.update(C.id, { synth, raw, status: 'done', finishedAt: Date.now() });
    const tasks = this.extractTasks(synth.top3.map((t) => `- [ ] ${t.title} (담당: 나)`).join('\n'), room);
    if (tasks.length) this.bus.emit('memory', {});
    room.critique = { id: C.id, awaiting: null };
    this.saveProject(room);
    this.post(room.id, lead.id, critique.reportText(C), { kind: 'critique-report', team: 'critique', label: '크리틱 리포트', critiqueId: C.id, tasks, model: lead.model || '', ms: C.totals.ms, costUsd: C.totals.costUsd || undefined });
  }

  // 블라인드 비교: 같은 요청을 ① AI 1명 ② 팀(서로 다른 두 AI가 따로 초안 → 종합)으로 받아 섞어 보여준다.
  async compare(room, primary, other, merger, job, request) {
    if (!request) { this.post(room.id, 'system', '"/비교" 뒤에 요청을 적어 주세요. 예) /비교 졸업전시 주제 3개 추천해줘', { kind: 'limit' }); return; }
    const second = other && other.id !== primary.id ? other : Object.values(this.agents).find((a) => a.id !== primary.id) || primary;
    const joiner = merger && merger.id !== primary.id ? merger : primary;
    this.post(room.id, 'system', `블라인드 비교 · AI 1명(${primary.name})과 팀(${[primary.name, second.name].join('·')} → ${joiner.name} 종합)이 각자 답을 만듭니다`, { kind: 'stage', team: 'compare' });
    const t0 = Date.now();
    const singleP = this.ask(room, primary, job, team.prompts.single({ request })).then((res) => ({ res, ms: Date.now() - t0 }));
    const teamP = (async () => {
      const drafts = await Promise.all([primary, second].map((a) => this.ask(room, a, job, team.prompts.draft({ request }))));
      const ok = drafts.filter(Boolean);
      if (!ok.length) return { res: null };
      const merged = ok.length > 1 ? await this.ask(room, joiner, job, team.prompts.merge({ request, drafts: ok.map((d) => d.text) })) : ok[0];
      const cost = [...ok, merged].filter(Boolean).reduce((s, r) => s + (r.meta?.costUsd || 0), 0);
      return { res: merged, ms: Date.now() - t0, cost, agents: [primary.id, second.id, joiner.id] };
    })();
    const [single, teamOut] = await Promise.all([singleP, teamP]);
    if (!single.res || !teamOut.res) return;
    const order = Math.random() < 0.5 ? ['single', 'team'] : ['team', 'single'];
    const textOf = (side) => (side === 'single' ? single.res.text : teamOut.res.text);
    const ev = this.evals?.create({
      roomId: room.id, request, kind: team.taskKind(request), order,
      single: { ms: single.ms, costUsd: single.res.meta?.costUsd ?? null, agents: [primary.id] },
      team: { ms: teamOut.ms, costUsd: teamOut.cost || null, agents: teamOut.agents },
    });
    this.post(room.id, 'system', '두 답 중 더 나은 쪽을 고르세요. 누가 썼는지는 고른 뒤에 공개됩니다.', {
      kind: 'compare', evalId: ev?.id, options: { A: textOf(order[0]), B: textOf(order[1]) },
    });
  }

  // 사용자가 비교 결과를 고르면 공개하고, 대화의 비교 카드에 결과를 남긴다.
  chooseCompare(roomId, evalId, choice, reason) {
    const item = this.evals?.choose(evalId, choice, reason);
    if (!item) return null;
    const msg = this.store.messages(roomId).find((m) => m.meta?.evalId === evalId);
    if (msg) {
      msg.meta.choice = choice;
      msg.meta.reveal = { A: item.order[0], B: item.order[1] };
      this.store.save();
      this.bus.emit('update', msg);
    }
    const stats = this.evals.insights().total;
    const label = (side) => (side === 'team' ? '팀' : 'AI 1명');
    const picked = choice === 'tie' ? '비슷함' : `${choice}(${label(item.winner)})`;
    this.post(roomId, 'system', `공개 · A는 ${label(item.order[0])}, B는 ${label(item.order[1])}의 답이었습니다. 고른 답: ${picked} · 누적 ${stats.n}회 중 팀 승 ${stats.team}회`, { kind: 'memory' });
    return item;
  }

  // ── 온보딩: 답을 바탕으로 팀 페르소나를 맞춤화하고 첫 작업을 추천한다 ─────
  async onboarding(answers) {
    const A = team.cleanAnswers(answers);
    const userName = this.profiles.user.name || '나';
    for (const text of team.userFacts(A)) this.memory.add('user', { text }, { save: false });
    this.memory.save();
    if (!this.profiles.user.bio) this.profiles.updateUser({ bio: team.userFacts(A).join(' · ').slice(0, 500) });

    // 가능하면 AI 가 역할별 맞춤 지침과 첫 작업을 만든다. 연결 전이거나 실패하면 기본값을 쓴다.
    let notes = {};
    let suggestions = null;
    const useMock = this.profiles.agents().some((a) => a.engine === 'mock');
    try {
      const res = await this.engines[useMock ? 'mock' : 'claude']({
        prompt: team.onboardingPrompt(A, userName), sessionId: null, cwd: this.workspace,
        agent: { id: 'onboarding', name: '온보딩', role: 'onboarding', noTools: true, model: this.profiles.settings.curatorModel, systemPrompt: '사용자 맞춤 설정을 만듭니다. 요청된 JSON만 출력합니다.' },
      });
      const j = parseJson(res.text) || {};
      if (j.notes && typeof j.notes === 'object') notes = j.notes;
      if (Array.isArray(j.suggestions)) {
        suggestions = j.suggestions.filter((x) => x && x.title && x.prompt).slice(0, 3)
          .map((x) => ({ title: String(x.title).slice(0, 30), service: ['critique', 'concept', 'research', 'chat'].includes(x.service) ? x.service : 'chat', prompt: String(x.prompt).slice(0, 400) }));
      }
    } catch { /* 기본값 사용 */ }
    if (!suggestions?.length) suggestions = team.defaultSuggestions(A);

    // 역할 6개를 채운다: 있으면 맞춤화, 없으면 템플릿으로 만든다 (Claude 는 프로듀서, Codex 는 검증을 우선 맡는다).
    const tone = team.TONES[A.tone];
    const ctx = team.userContext(A, userName);
    for (const role of ['pm', 'research', 'concept', 'critic', 'producer', 'verifier']) {
      let agent = this.profiles.agents().find((a) => a.studioRole === role);
      if (!agent && role === 'producer') agent = this.profiles.agents().find((a) => a.engine === 'claude' && !a.studioRole);
      if (!agent && role === 'verifier') agent = this.profiles.agents().find((a) => a.engine === 'codex' && !a.studioRole);
      const tpl = PERSONA_TEMPLATES.find((t) => t.studioRole === role);
      const name = agent?.name || tpl.name;
      const soul = [soulFor(role, name, userName), ctx, notes[role] ? `[맞춤 지침] ${String(notes[role]).slice(0, 400)}` : ''].filter(Boolean).join('\n\n');
      const patch = { studioRole: role, soul, personality: role === 'critic' || role === 'pm' ? tone.personality : (agent?.personality || tpl.personality) };
      if (agent) this.profiles.updateAgent(agent.id, patch);
      else {
        const engine = role === 'verifier' && this.profiles.agents().some((a) => a.engine === 'codex') ? 'codex' : (useMock ? 'mock' : 'claude');
        this.profiles.createAgent({ ...patch, name, title: tpl.title, emoji: tpl.emoji, color: tpl.color, engine, model: engine === 'claude' && role !== 'producer' ? this.profiles.settings.teamModel || '' : '' });
      }
    }
    const producer = this.profiles.agents().find((a) => a.studioRole === 'producer');
    this.profiles.updateSettings({ onboarded: true, primaryAgent: producer?.id });
    this.bus.emit('agents', {});
    this.bus.emit('memory', {});
    return { agents: this.profiles.agents(), suggestions };
  }

  // ── 검토 ─────────────────────────────────
  async reviewLoop(room, members, job) {
    const [workerId, ...reviewerIds] = members;
    const worker = this.agents[workerId];
    for (let round = 1; round <= room.maxRounds; round++) {
      if (!(await this.turn(room, worker, job, { round, phase: 'work' }))) return;
      let allPass = true;
      for (const rid of reviewerIds) {
        const r = await this.turn(room, this.agents[rid], job, { round, phase: 'review', worker });
        if (!r) return;
        if (r.verdict !== 'pass') allPass = false;
      }
      if (allPass) {
        this.post(room.id, 'system', `검토 통과 · ${round}라운드`, { kind: 'pass', round });
        return;
      }
    }
    this.post(room.id, 'system', `최대 ${room.maxRounds}라운드에 도달해 여기서 멈춥니다. 남은 쟁점은 위 대화를 참고하세요.`, { kind: 'limit' });
  }

  // ── 회의 ─────────────────────────────────
  async meetingLoop(room, members, job) {
    const chair = this.agents[members[0]];
    const total = room.maxRounds;
    this.post(room.id, 'system', `회의 시작 · 의장 ${chair.name} · 최대 ${total}라운드`, { kind: 'meeting-start' });
    let agreed = false;
    const stance = {};
    for (let round = 1; round <= total && !agreed; round++) {
      // 2라운드부터는 이견을 낸 AI만 다시 발언한다 (동의한 AI가 같은 말을 반복하며 토큰을 쓰지 않게).
      const speakers = round === 1 ? members : members.filter((id) => stance[id] !== 'agree');
      for (const id of speakers) {
        const r = await this.turn(room, this.agents[id], job, { round, total, phase: 'meeting', chair });
        if (!r) return;
        stance[id] = r.stance;
      }
      const dissent = members.filter((id) => stance[id] !== 'agree').length;
      // 전원 합의, 또는 3명 이상이면 과반 합의로 끝낸다. 남은 이견은 의장이 회의록에서 결정한다.
      if (dissent === 0 || (members.length >= 3 && dissent * 2 < members.length)) agreed = true;
    }
    this.post(room.id, 'system', agreed ? '모두 합의했습니다. 의장이 회의록을 정리합니다.' : `최대 ${total}라운드 종료. 의장이 회의록을 정리합니다.`, { kind: agreed ? 'pass' : 'limit' });
    await this.turn(room, chair, job, { phase: 'minutes', chair });
  }

  // ── 작업 ─────────────────────────────────
  reviewerOf(members) {
    const [chairId, ...rest] = members;
    void chairId;
    return rest.find((id) => this.agents[id]?.engine === 'codex') || rest.find((id) => this.agents[id]?.personality === 'critic') || null;
  }

  parseAssignments(text, members, reviewerId) {
    const byName = new Map(members.map((id) => [this.agents[id]?.name, id]));
    const out = [];
    let inAssign = false;
    for (const line of text.split('\n')) {
      if (/^\s*[#*]*\s*배정/.test(line)) { inAssign = true; continue; }
      if (!inAssign) continue;
      const m = line.match(ASSIGN_RE);
      if (!m) continue;
      const name = m[1].replace(/[*_`@]/g, '').trim();
      const id = byName.get(name) || [...byName.entries()].find(([n]) => n && name.includes(n))?.[1];
      if (id && id !== reviewerId && !out.some((a) => a.id === id)) out.push({ id, task: m[2].replace(/[*_`]/g, '').trim() });
    }
    return out.slice(0, 3);
  }

  async workLoop(room, members, job) {
    const chair = this.agents[members[0]];
    const reviewerId = this.reviewerOf(members);
    const reviewer = reviewerId ? this.agents[reviewerId] : null;
    this.post(room.id, 'system', `작업 시작 · 총괄 ${chair.name}${reviewer ? ` · 검토 ${reviewer.name}` : ''}`, { kind: 'meeting-start' });

    const plan = await this.turn(room, chair, job, { phase: 'plan', members, reviewer });
    if (!plan) return;
    let assigned = this.parseAssignments(plan.text, members, reviewerId);
    if (!assigned.length) assigned = [{ id: chair.id, task: '계획대로 직접 수행' }];
    this.post(room.id, 'system', `배정 · ${assigned.map((a) => `${this.agents[a.id].name}: ${a.task}`).join(' / ')}`, { kind: 'assign' });

    for (const a of assigned) {
      if (!(await this.turn(room, this.agents[a.id], job, { phase: 'task', task: a.task }))) return;
    }

    let passed = !reviewer;
    const maxFix = Math.min(room.maxRounds || 1, 3);
    for (let round = 1; reviewer && round <= maxFix + 1; round++) {
      const r = await this.turn(room, reviewer, job, { phase: 'check', round });
      if (!r) return;
      if (r.verdict === 'pass') { passed = true; break; }
      if (round > maxFix) break;
      // 지적에 이름이 나온 담당자만 고친다. 없으면 마지막 담당자.
      const named = assigned.filter((a) => r.text.includes(this.agents[a.id].name));
      for (const a of named.length ? named : assigned.slice(-1)) {
        if (!(await this.turn(room, this.agents[a.id], job, { phase: 'fix', round }))) return;
      }
    }
    this.post(room.id, 'system', passed ? '완료 기준 충족 · 총괄이 최종 보고합니다' : `수정 ${maxFix}회 후에도 남은 지적이 있습니다 · 총괄이 최종 보고합니다`, { kind: passed ? 'pass' : 'limit' });
    await this.turn(room, chair, job, { phase: 'report' });
  }

  // ── 스튜디오 ─────────────────────────────
  // 역할은 이름이 아니라 프로필의 studioRole 로 찾는다.
  roles(members) {
    const by = (r) => members.find((id) => this.agents[id]?.studioRole === r) || null;
    const pm = by('pm') || members[0];
    const producer = by('producer') || members.find((id) => this.agents[id]?.engine === 'claude' && id !== pm) || pm;
    return { pm, producer, research: by('research'), concept: by('concept') || pm, critic: by('critic'), verifier: by('verifier') };
  }

  saveProject(room) {
    this.store.save();
    this.bus.emit('rooms', {});
  }

  async studioLoop(room, members, job, text) {
    const P = room.project;
    if (studio.CANCEL_RE.test(text)) {
      if (P && P.stage !== 'done') {
        Object.assign(P, { stage: 'done', awaiting: null, cancelled: true, finishedAt: Date.now() });
        this.saveProject(room);
        this.post(room.id, 'system', `프로젝트를 닫았습니다 · ${P.title || ''}`, { kind: 'stopped' });
      }
      return;
    }
    if (P?.awaiting && P.stage !== 'done') return this.resumeStudio(room, members, job, text);
    return this.startStudio(room, members, job, text);
  }

  async startStudio(room, members, job, text) {
    const R = this.roles(members);
    const forced = /^\s*\/스튜디오/.test(text);
    const P = {
      id: Math.random().toString(36).slice(2, 8), request: text.replace(/^\s*\/스튜디오\s*/, '').trim(), title: null,
      stage: 'brief', awaiting: null, docs: { feedback: [] }, sessions: {}, round: 0, startedAt: Date.now(),
    };
    room.project = P;
    const brief = await this.soloTurn(room, this.agents[R.pm], job, 'brief', studio.prompts.brief(P, { forced }), { silent: true });
    if (!brief) { room.project = null; this.saveProject(room); return; }
    const type = forced ? '사고형' : studio.parseType(brief) || '사고형';
    if (type !== '사고형') {
      room.project = null;
      this.saveProject(room);
      if (type === '학습형') {
        await this.soloTurn(room, this.agents[R.research || R.pm], job, 'teach', studio.prompts.teach(P));
        return;
      }
      this.post(room.id, 'system', '실행형 요청 · 컨펌 없이 바로 끝까지 진행합니다', { kind: 'meeting-start' });
      const ordered = [R.pm, ...members.filter((id) => id !== R.pm)];
      return this.workLoop(room, ordered, job);
    }
    P.title = studio.parseTitle(brief) || P.request.slice(0, 20);
    P.docs.brief = brief;
    this.post(room.id, R.pm, brief.replace(/^\s*[*_`#]*\s*유형\s*[:：].*\n?/m, '').trim(), this.studioMeta(this.agents[R.pm], 'brief', job.lastRes || {}));
    P.awaiting = 'A';
    this.post(room.id, 'system', studio.GATES.A.hint, studio.gateMeta('A'));
    this.saveProject(room);
  }

  async resumeStudio(room, members, job, text) {
    const P = room.project;
    const R = this.roles(members);
    const A = (id) => (id ? this.agents[id] : null);
    // 연결되지 않은 검증 담당은 빼고, 뺐다는 사실을 단계 안내에 적는다.
    const ready = await this.readyCheck();
    const noVerify = R.verifier && !ready(A(R.verifier)) ? ` · 검증 생략됨(${this.skipReason(members)})` : '';
    if (noVerify) R.verifier = null;
    const principles = () => this.memory.principlesText();
    const solo = (id, phase, extra = {}) => (id ? this.soloTurn(room, A(id), job, phase, studio.prompts[phase](P, { principles: principles() }), extra) : Promise.resolve(null));

    if (P.awaiting === 'A') {
      P.docs.answers = studio.PASS_RE.test(text) ? '패스 — 사용자가 판단을 팀에 맡김(외주로 기록). 팀이 가장 유력한 가설로 진행.' : text;
      P.stage = 'diverge';
      this.saveProject(room);
      this.post(room.id, 'system', `발산 · ${[A(R.research)?.name, A(R.concept)?.name].filter(Boolean).join('·')}가 서로의 결과를 보지 않고 각자 작업합니다`, { kind: 'stage' });
      const [facts, directions] = await Promise.all([solo(R.research, 'facts'), solo(R.concept, 'directions')]);
      if (!directions) return;
      Object.assign(P.docs, { facts, directions });
      this.post(room.id, 'system', `크리틱 · ${[A(R.critic)?.name, A(R.verifier)?.name].filter(Boolean).join('·') || A(R.pm).name}가 내 기준으로 채점합니다${noVerify}`, { kind: 'stage' });
      const [critique, verify] = await Promise.all([solo(R.critic, 'critique'), solo(R.verifier, 'verify')]);
      Object.assign(P.docs, { critique, verify });
      const decision = await solo(R.pm, 'decision');
      if (!decision) return;
      P.docs.decision = decision;
      P.stage = 'decide';
      P.awaiting = 'B';
      const actions = studio.parseOptions(decision).map((o) => ({ label: `${o}안`, send: `${o}안으로 진행` }));
      this.post(room.id, 'system', studio.GATES.B.hint, studio.gateMeta('B', { actions }));
      this.saveProject(room);
      return;
    }

    if (P.awaiting === 'B') {
      P.docs.choice = text;
      P.stage = 'produce';
      this.saveProject(room);
      await this.learnPrinciples(room, 'B', P.docs.decision, text);
      this.post(room.id, 'system', `시안 제작 · ${A(R.producer).name}`, { kind: 'stage' });
      const draft = await solo(R.producer, 'produce', { session: true });
      if (!draft) return;
      P.docs.draft = draft;
      await this.reviewDraft(room, R, solo);
      return;
    }

    if (P.awaiting === 'C') {
      if (studio.CONFIRM_RE.test(text)) {
        // 피그마·노션 등 외부에 시안을 만든 경우에만 확정 작업을 한다. 채팅으로 낸 결과물은 그대로가 확정본이다.
        if (/figma\.com|notion\.(so|site)|docs\.google|claude\.ai\/|https?:\/\//i.test(P.docs.draft || '')) await solo(R.producer, 'final', { session: true });
        else this.post(room.id, 'system', '확정 · 채팅에 남은 시안이 확정본입니다', { kind: 'pass' });
        P.stage = 'done';
        P.awaiting = null;
        P.finishedAt = Date.now();
        this.saveProject(room);
        await solo(R.pm, 'report');
        return;
      }
      P.docs.feedback.push(text);
      P.round++;
      this.saveProject(room);
      await this.learnPrinciples(room, 'C', `${P.docs.draft || ''}\n${P.docs.review || ''}`, text);
      const revised = await solo(R.producer, 'revise', { session: true });
      if (!revised) return;
      P.docs.draft = revised;
      await this.reviewDraft(room, R, solo);
    }
  }

  async reviewDraft(room, R, solo) {
    const P = room.project;
    const [review, check] = await Promise.all([solo(R.critic, 'review'), P.round === 0 ? solo(R.verifier, 'check') : null]);
    P.docs.review = [review, check].filter(Boolean).join('\n\n');
    P.awaiting = 'C';
    this.post(room.id, 'system', studio.GATES.C.hint, studio.gateMeta('C'));
    this.saveProject(room);
  }

  studioMeta(agent, phase, res) {
    const meta = { ...(res.meta || {}), model: agent.model || '', studio: phase, label: studio.LABEL[phase] };
    return meta;
  }

  // 세션 없이(또는 프로젝트 전용 세션으로) 지시서만 주고 실행한다. 대화 전체를 읽지 않아 서로에게 끌려가지 않는다.
  async soloTurn(room, agent, job, phase, prompt, { silent = false, session = false } = {}) {
    const signal = job.controller.signal;
    if (signal.aborted) throw Object.assign(new Error('중단됨'), { aborted: true });
    const engine = this.engines[agent.engine];
    if (!engine) return null;
    const P = room.project;
    const sessionId = session ? P?.sessions?.[agent.id] || null : null;
    this.bus.emit('typing', { roomId: room.id, agentId: agent.id, on: true });
    let res;
    try {
      res = await engine({
        prompt, sessionId, agent: this.runtimeAgent(agent, room), cwd: this.workspace, signal, onEvent: this.activity(room, agent), images: this.imagesFor(room),
        onSpawn: (child) => { job.children.add(child.pid); child.on('close', () => job.children.delete(child.pid)); },
      });
    } catch (err) {
      if (err.aborted) throw err;
      this.fail(room, agent, err);
      return null;
    } finally {
      this.bus.emit('typing', { roomId: room.id, agentId: agent.id, on: false });
    }
    if (session && P) P.sessions[agent.id] = res.sessionId;
    job.lastRes = res; // silent 로 받은 응답을 나중에 올릴 때 비용·시간 정보를 함께 쓰기 위해
    const text = res.text || '(빈 응답)';
    if (!silent) {
      const meta = this.studioMeta(agent, phase, res);
      if (phase === 'report') {
        meta.kind = 'minutes';
        meta.tasks = this.extractTasks(text, room);
        if (meta.tasks.length) this.bus.emit('memory', {});
      }
      this.post(room.id, agent.id, text, meta);
    }
    return text;
  }

  // 최근 사용자 메시지에 붙은 이미지 (Codex 는 -i 로 직접 넘긴다. Claude 는 프롬프트의 경로를 Read 도구로 연다)
  imagesFor(room) {
    const recent = this.store.messages(room.id).slice(-12).filter((m) => m.sender === 'user' && m.meta?.files?.length);
    return recent.flatMap((m) => m.meta.files.filter((f) => f.image).map((f) => f.path)).slice(-6);
  }

  // 실시간 진행: 엔진 이벤트(도구 사용, 글자 단위 출력)를 화면으로 보낸다. 글자는 0.25초마다 묶어서 보낸다.
  activity(room, agent) {
    let label = '생각 중';
    let text = '';
    let last = 0;
    const emit = () => this.bus.emit('activity', { roomId: room.id, agentId: agent.id, label, text: text.slice(-900) });
    return (ev) => {
      if (ev.type === 'tool') { label = ev.label; text = ''; emit(); }
      else if (ev.type === 'textStart') { if (text) text += '\n\n'; }
      else if (ev.type === 'text') {
        label = '쓰는 중';
        text += ev.delta;
        const now = Date.now();
        if (now - last > 250) { last = now; emit(); }
      }
    };
  }

  // 컨펌 때 사용자가 고르거나 돌려보낸 이유에서 "내 기준"을 배운다.
  async learnPrinciples(room, gate, context, reply) {
    if (!reply || reply.length < 4) return;
    const engine = this.engines[this.profiles.agents().some((a) => a.engine === 'mock') ? 'mock' : 'claude'];
    try {
      const res = await engine({
        prompt: studio.prompts.learn({ gate, context, reply, existing: this.memory.principlesText() }),
        sessionId: null,
        agent: { id: 'learner', name: '기준 학습', role: 'learner', noTools: true, model: this.profiles.settings.curatorModel, systemPrompt: '사용자의 판단 기준을 추출합니다. 요청된 JSON만 출력합니다.' },
        cwd: this.workspace,
      });
      const added = (parseJson(res.text)?.add || []).map((t) => this.memory.add('principles', { text: t, learned: true, source: room.project?.title || room.name })).filter(Boolean);
      if (added.length) {
        this.bus.emit('memory', {});
        this.post(room.id, 'system', `내 기준에 추가 · ${added.map((x) => x.text).join(' / ')}`, { kind: 'memory' });
      }
    } catch (err) {
      console.error('기준 학습 실패:', err.message);
    }
  }

  // ── 프롬프트 ─────────────────────────────
  instruction(room, agent, ctx) {
    const names = (ids) => ids.map((id) => this.agents[id]?.name).filter(Boolean).join(', ');
    switch (ctx.phase) {
      case 'review':
        return ctx.round > 1
          ? `직전 검토에서 지적한 문제가 ${ctx.worker.name}의 수정본에서 고쳐졌는지만 확인하세요. 새 지적을 추가하지 마세요. 고쳐졌거나 반박이 타당하면 통과입니다. ${VERDICT_LINE}`
          : `위 대화에서 ${ctx.worker.name}의 가장 최근 답변을 검토하세요. 답을 틀리게 만드는 문제(사실 오류, 계산 실수, 근거 없는 주장, 사용자 요청 누락)만 최대 3개, 각 한 줄로 쓰세요. 문체·더 나은 방법 제안·범위 밖 요구는 쓰지 마세요. ${VERDICT_LINE}`;
      case 'plan': {
        const pool = ctx.members.filter((id) => id !== ctx.reviewer?.id).map((id) => { const a = this.agents[id]; return `${a.name}${a.title ? `(${a.title})` : ''}`; }).join(', ');
        return `당신은 이번 작업의 총괄입니다. 토론하지 말고 계획만 짧게 쓰세요. 배정 가능한 AI: ${pool}.\n형식을 정확히 지키세요:\n목표: (한 줄)\n완료 기준:\n- (사용자가 받아야 할 산출물을 확인 가능한 형태로 2~4개)\n배정:\n- 이름: 할 일 한 줄\n규칙: 요청을 끝내는 데 꼭 필요한 AI만 1~3명 배정하세요(당신 자신도 가능). 실제 파일·페이지·도구 작업은 가장 적합한 한 명에게 몰아주세요. 사용자 요청 범위를 넓히지 말고, 현장 조사처럼 사람이 해야 하는 일은 완료 기준에 넣지 마세요.${ctx.reviewer ? ` ${ctx.reviewer.name}은(는) 마지막에 자동으로 검토하므로 배정하지 마세요.` : ''}`;
      }
      case 'task':
        return `총괄이 당신에게 맡긴 일: "${ctx.task}". 토론하거나 다른 AI의 의견을 평가하지 말고, 직접 수행해서 결과물을 내세요. 필요하면 도구를 쓰고, 만들어야 할 파일·페이지가 있으면 실제로 만드세요. 새 조사 범위나 조건을 추가하지 마세요. 끝나면 ① 한 일 ② 결과물(본문·링크·경로) ③ 못 한 것과 이유(있을 때만)를 보고하세요.`;
      case 'check':
        return ctx.round > 1
          ? `직전 검토에서 지적한 문제가 고쳐졌는지만 확인하세요. 새 지적을 추가하지 마세요. 고쳐졌거나, 고칠 수 없는 이유가 타당하면 통과입니다. ${VERDICT_LINE}`
          : `총괄이 정한 "완료 기준"에만 비추어 결과물을 검토하세요. 완료 기준을 못 채우게 하는 '막는 문제'만 최대 3개, 각 한 줄로, 누가 고쳐야 하는지 이름을 붙여 쓰세요. 더 나은 방법 제안, 문체, 범위 밖 요구, 추가 조사 요청, 사람이 직접 해야 하는 일은 문제로 치지 마세요. ${VERDICT_LINE}`;
      case 'fix':
        return '감사 담당의 지적 중 당신 결과물에 해당하는 것만 고쳐서, 바뀐 부분을 보고하세요. 지적이 틀렸거나 범위 밖이면 한 줄 근거로 넘어가세요. 새 작업을 벌이지 마세요.';
      case 'report':
        return '작업이 끝났습니다. 사용자에게 최종 보고를 쓰세요. 토론 과정은 요약하지 마세요. 형식:\n## 결과\n(완성된 산출물 요약, 링크·경로)\n## 완료 기준\n- ✓ 또는 ✗ 기준 (✗면 이유 한 줄)\n## 남은 일\n사람(사용자)이 할 일만 한 줄에 하나씩 "- [ ] 내용 (담당: 나, 기한: YYYY-MM-DD)" 형식으로. 기한을 모르면 기한 부분은 생략하세요. 없으면 "없음".';
      case 'work':
        return ctx.round > 1
          ? '감사 담당의 지적을 반영해 답변을 처음부터 끝까지 다시 완성해서 쓰세요. 동의하지 않는 지적은 근거를 들어 반박해도 됩니다.'
          : '사용자의 요청에 답하세요. 이 답변은 감사 담당 AI가 검토합니다.';
      case 'meeting': {
        const opener = ctx.round === 1 && agent.id === ctx.chair.id;
        const base = opener
          ? `지금은 회의 1라운드이고 당신이 의장입니다. 참석자: ${names(room.members)}. 사용자가 준 안건을 한 문장으로 정리하고, 논의할 쟁점 2~3개와 당신의 첫 의견을 제시하세요.`
          : ctx.round === 1
            ? `지금은 회의 1/${ctx.total}라운드입니다(의장: ${ctx.chair.name}, 참석자: ${names(room.members)}). 다른 참석자의 발언에 동의·반박·보완하되, 이미 나온 말은 반복하지 말고 당신의 페르소나 관점에서 새 근거를 하나만 더하세요. 3~5문장.`
            : `지금은 회의 ${ctx.round}/${ctx.total}라운드이고, 지난 라운드에 이견을 낸 사람만 발언합니다. 이견이 여전하면 반박 대신 구체적인 대안 1개를 제시하세요. 설득됐거나 새로 보탤 근거가 없으면 한 줄만 쓰고 합의하세요. 3문장 이내.`;
        return `${base} 사용자가 준 범위를 넓히지 마세요(새 조사·새 조건 추가 금지). 사소한 차이는 이견으로 치지 마세요. 마지막 줄에는 반드시 "입장: 합의"(현재 방향으로 진행해도 됨) 또는 "입장: 이견"(이대로 가면 결과가 틀림) 중 하나만 쓰세요.`;
      }
      case 'minutes':
        return '회의가 끝났습니다. 의장으로서 회의록을 작성하세요. 남은 이견은 의장이 하나로 결정하고 이유를 한 줄로 쓰세요. 형식:\n## 결론\n## 근거 요약\n## 남은 쟁점\n## 할 일\n할 일은 한 줄에 하나씩 "- [ ] 내용 (담당: 이름, 기한: YYYY-MM-DD)" 형식으로 쓰고, 사람(사용자)이 할 일의 담당은 "나"로 쓰세요. 기한을 모르면 기한 부분은 생략하세요.';
      default:
        return '사용자에게 답하세요.';
    }
  }

  buildPrompt(room, agent, msgs, ctx, contextBlock) {
    const lines = msgs.map((m) => `${this.senderLabel(m.sender)}: ${this.aiText(m)}`);
    const multi = room.members.length > 1;
    const head = multi ? `[${room.name} 대화방 · 새 메시지]` : '[새 메시지]';
    const pre = contextBlock ? `[최신 기억 업데이트]\n${contextBlock}\n\n` : '';
    return `${pre}${head}\n${lines.join('\n\n') || '(새 메시지 없음)'}\n\n— 지금은 당신(${agent.name}) 차례입니다. ${this.instruction(room, agent, ctx)} 메시지 본문만 쓰세요.`;
  }

  senderLabel(sender) {
    if (sender === 'user') return `${this.profiles.user.name}(사람)`;
    if (sender === 'system') return '(시스템)';
    return this.agents[sender]?.name || sender;
  }

  memoryContext(roomId) {
    const roomNames = Object.fromEntries(this.store.listRooms().map((r) => [r.id, r.name]));
    return this.memory.context({ roomId, roomNames });
  }

  systemPrompt(agent, room) {
    const now = this.now();
    const others = room.members.filter((id) => id !== agent.id).map((id) => this.agents[id]).filter(Boolean);
    const personality = PERSONALITIES[agent.personality]?.text;
    const parts = [
      agent.soul || `당신은 '${agent.name}'입니다.`,
      personality ? `[성격] ${personality}` : '',
      agent.studioRole ? `[스튜디오 역할] ${STUDIO_ROLES[agent.studioRole]?.label} — ${STUDIO_ROLES[agent.studioRole]?.desc}. 이 범위 밖의 일은 하지 않는다.` : '',
      `[정체성] 당신의 이름은 '${agent.name}'${agent.title ? `, 역할은 '${agent.title}'` : ''}입니다. 당신은 ${agent.engine === 'codex' ? 'OpenAI Codex CLI' : 'Claude Code'} 위에서 동작하는 에이전트이며, 'DOMO'라는 디자인 스튜디오 메신저에서 사람 1명(${this.profiles.user.name})${others.length ? `, 다른 AI(${others.map((o) => `${o.name}${o.title ? `·${o.title}` : ''}`).join(', ')})` : ''}와 함께 일합니다. 다른 AI의 발언은 "이름: 내용" 형식으로 전달됩니다.`,
      `[오늘] ${localDate(now)} (${'일월화수목금토'[now.getDay()]}요일)`,
      this.profiles.user.bio ? `[사용자 소개] ${this.profiles.user.bio}` : '',
      '[기억 규칙] 아래 기억은 모든 AI가 공유하는 장기 기억입니다. 답변에 자연스럽게 활용하세요. 과거 대화 원문이 필요하면 작업 폴더의 "대화기록" 폴더를 검색하세요. 대화에서 새로 알게 된 사실은 대화가 끝난 뒤 자동으로 기억에 반영되므로 따로 저장하지 않아도 됩니다.',
      agent.useMemory !== false ? this.memoryContext(room.id) : '',
      // Claude Code 는 작업 폴더의 스킬 파일을 직접 쓰므로, 스킬 파일을 못 읽는 엔진에만 요약을 넣는다.
      agent.engine !== 'claude' ? this.skills?.promptText() || '' : '',
      '[메신저 규칙] 한국어로 메신저답게 간결하게 쓰세요. 필요할 때만 목록·표·코드 블록을 쓰세요.',
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  // 프로필 → 엔진이 쓰는 실행 설정
  runtimeAgent(agent, room) {
    const perm = PERMISSIONS[agent.permission] || PERMISSIONS.read;
    const pluginTools = (agent.plugins || []).map((name) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_')}`);
    return {
      ...agent,
      systemPrompt: this.systemPrompt(agent, room),
      allowedTools: [...perm.claude.allow, ...pluginTools],
      disallowedTools: perm.claude.deny,
      sandbox: perm.codex,
      mcpConfig: this.plugins?.mcpConfigPath(),
    };
  }

  async turn(room, agent, job, ctx = {}) {
    const signal = job.controller.signal;
    if (signal.aborted) throw Object.assign(new Error('중단됨'), { aborted: true });
    const state = this.store.agentState(room, agent.id);
    const engine = this.engines[agent.engine];
    if (!engine) {
      this.post(room.id, 'system', `${agent.name}: 알 수 없는 엔진 '${agent.engine}'`, { kind: 'error', agentId: agent.id });
      return null;
    }

    const call = async (fresh) => {
      const cursor = fresh ? 0 : state.cursor;
      let msgs = this.store.messagesSince(room.id, cursor).filter((m) => m.sender !== agent.id || fresh);
      msgs = msgs.filter((m) => !['stopped', 'meeting-start'].includes(m.meta?.kind));
      if (fresh) msgs = msgs.slice(-HISTORY_LIMIT);
      const seenUpTo = this.store.messages(room.id).at(-1)?.id || 0;
      const runtime = this.runtimeAgent(agent, room);
      // Codex 는 시스템 프롬프트를 새 세션에만 넣을 수 있어서, 기억이 바뀌었으면 메시지 앞에 붙여준다.
      const needsContext = !fresh && agent.engine !== 'claude' && agent.useMemory !== false && state.memVersion !== this.memory.version;
      const prompt = this.buildPrompt(room, agent, msgs, ctx, needsContext ? this.memoryContext(room.id) : '');
      const res = await engine({
        prompt,
        sessionId: fresh ? null : state.sessionId,
        agent: runtime,
        cwd: this.workspace,
        signal,
        onEvent: this.activity(room, agent),
        images: this.imagesFor(room),
        onSpawn: (child) => {
          job.children.add(child.pid);
          child.on('close', () => job.children.delete(child.pid));
        },
      });
      return { res, seenUpTo };
    };

    this.bus.emit('typing', { roomId: room.id, agentId: agent.id, on: true });
    let out;
    try {
      try {
        out = await call(!state.sessionId);
      } catch (err) {
        if (err.aborted || !err.sessionProblem) throw err;
        out = await call(true);
      }
    } catch (err) {
      if (err.aborted) throw err;
      this.fail(room, agent, err);
      return null;
    } finally {
      this.bus.emit('typing', { roomId: room.id, agentId: agent.id, on: false });
    }

    const { res, seenUpTo } = out;
    state.sessionId = res.sessionId;
    state.cursor = seenUpTo;
    state.memVersion = this.memory.version;
    let text = res.text;
    const meta = { ...res.meta, model: agent.model || '' };
    if (ctx.round) meta.round = ctx.round;
    let verdict = null;
    let stance = null;
    if (ctx.phase === 'review' || ctx.phase === 'check') {
      const m = text.match(VERDICT_RE);
      verdict = m ? (m[1] === '통과' ? 'pass' : 'revise') : 'revise';
      if (m) text = text.replace(VERDICT_RE, '').trim();
      // 감사 AI가 "판정: 통과" 한 줄만 쓰면 본문이 비므로, 판정을 말로 남긴다.
      if (!text) text = verdict === 'pass' ? '검토했습니다. 문제 없습니다.' : '수정이 필요합니다.';
      meta.verdict = verdict;
    }
    if (ctx.phase === 'meeting') {
      const m = text.match(STANCE_RE);
      stance = m ? (m[1] === '합의' ? 'agree' : 'disagree') : 'disagree';
      if (m) text = text.replace(STANCE_RE, '').trim();
      if (!text) text = stance === 'agree' ? '지금 방향에 동의합니다.' : '아직 이견이 있습니다.';
      meta.stance = stance;
    }
    if (ctx.phase === 'plan') meta.kind = 'plan';
    if (ctx.phase === 'task' || ctx.phase === 'fix') meta.phase = ctx.phase;
    if (ctx.phase === 'minutes' || ctx.phase === 'report') {
      meta.kind = 'minutes';
      if (ctx.phase === 'report') meta.label = '작업 보고';
      meta.tasks = this.extractTasks(text, room);
      if (meta.tasks.length) this.bus.emit('memory', {});
    }
    this.store.save();
    this.post(room.id, agent.id, text || '(빈 응답)', meta);
    return { verdict, stance, text };
  }

  // 회의록의 "- [ ] 할 일 (담당: 나, 기한: 2026-10-01)" 을 과제로 등록한다.
  extractTasks(text, room) {
    const ids = [];
    for (const m of text.matchAll(TASK_RE)) {
      let body = m[1];
      const due = body.match(/기한\s*[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '';
      const owner = body.match(/담당\s*[:：]\s*([^,)]+)/)?.[1]?.trim() || '';
      body = body.replace(/\s*\((?:[^()]*(?:담당|기한)[^()]*)\)\s*$/, '').trim();
      const t = this.memory.add('tasks', { title: body, due, owner, source: `${room.name} 회의` }, { save: false });
      if (t) ids.push(t.id);
    }
    if (ids.length) this.memory.save();
    return ids;
  }

  // ── 기억 정리 (대화가 끝난 뒤 자동) ─────────
  curate(roomId) {
    if (!this.profiles.settings.autoMemory) return Promise.resolve(null);
    const prev = this.curating.get(roomId) || Promise.resolve();
    const p = prev.then(() => this.#curate(roomId)).catch((err) => {
      console.error('기억 정리 실패:', err.message);
      return null;
    });
    this.curating.set(roomId, p);
    return p;
  }

  async #curate(roomId) {
    const room = this.store.getRoom(roomId);
    if (!room) return null;
    const msgs = this.store.messagesSince(roomId, room.curatedUpTo || 0).filter((m) => m.sender !== 'system');
    if (!msgs.some((m) => m.sender === 'user')) return null;
    const upTo = this.store.messages(roomId).at(-1).id;
    const mem = this.memory.all();
    const snapshot = {
      user: mem.user.map((x) => x.text),
      notes: mem.notes.slice(-30).map((x) => x.text),
      projects: mem.projects.map((p) => ({ name: p.name, status: p.status, desc: p.desc })),
      tasks: mem.tasks.filter((t) => t.status !== 'done').map((t) => ({ id: t.id, title: t.title, due: t.due })),
      room_summary: mem.roomSummaries[roomId]?.text || '',
    };
    const convo = msgs.slice(-40).map((m) => `${this.senderLabel(m.sender)}: ${m.text.slice(0, 1500)}`).join('\n\n');
    const prompt = `오늘은 ${localDate(this.now())}입니다. 아래는 현재 장기 기억과, 대화방 "${room.name}"의 새 대화입니다.\n\n[현재 기억]\n${JSON.stringify(snapshot, null, 1)}\n\n[새 대화]\n${convo}\n\n새 대화에서 앞으로도 쓸모 있는 정보만 골라 기억을 갱신하세요. 규칙:\n- user_add: 사용자 본인에 대한 지속적인 사실·선호(전공, 일정 습관, 말투 선호 등). 이미 있는 것과 같은 내용은 넣지 마세요.\n- notes_add: 결정 사항, 중요한 결론, 다음에 참고할 지식.\n- projects_upsert: 사용자가 진행 중인 프로젝트·과제 주제 (name, desc, status: 진행 중|보류|완료, note: 이번 진척 한 줄).\n- tasks_add: 사용자가 해야 할 구체적인 할 일/과제 (title, due: YYYY-MM-DD 또는 "", project: 프로젝트 이름 또는 "").\n- tasks_done: 이번 대화에서 끝났다고 확인된 과제 id.\n- room_summary: 이 대화방의 지금까지 흐름 요약 2문장.\n- changes: 이번에 기억한 내용 한 줄 요약(없으면 "").\n- pattern: 이 대화의 요청이 사용자가 앞으로도 반복할 만한 "같은 형식의 작업"이면 {"key": "작업을 부르는 짧은 말(예: 판넬 문구 다듬기)", "name": "스킬 이름 15자 이내", "description": "언제 쓰는 스킬인지 한 문장", "steps": ["이번 대화에서 효과가 있었던 진행 절차를 3~6단계로"]}, 일회성 질문이면 null.\n일회성 잡담, AI끼리의 중간 논쟁, 추측은 기억하지 마세요. JSON 객체 하나만 출력하세요.`;
    const curator = this.profiles.agents().find((a) => a.engine !== 'codex') || {};
    const engine = this.engines[curator.engine === 'mock' ? 'mock' : 'claude'];
    const res = await engine({
      prompt,
      sessionId: null,
      agent: {
        id: 'curator', name: '기억 정리', role: 'curator', noTools: true,
        model: this.profiles.settings.curatorModel,
        systemPrompt: '당신은 대화에서 장기 기억을 추출하는 정리 담당입니다. 요청된 JSON만 출력합니다.',
      },
      cwd: this.workspace,
    });
    const json = parseJson(res.text);
    room.curatedUpTo = upTo;
    this.store.save();
    if (!json) return null;
    const applied = this.applyCuration(roomId, json);
    if (applied.count) {
      this.bus.emit('memory', {});
      this.post(roomId, 'system', `기억함 · ${json.changes || `${applied.count}개 항목`}`, { kind: 'memory', count: applied.count });
    }
    // 반복 작업 관찰 → 3번째에 스킬로 등록, 넘치면 오래 안 쓴 스킬 보관
    const seen = json.pattern && this.skills ? this.skills.observe(json.pattern, { source: room.name }) : null;
    if (seen) {
      applied.skill = seen;
      if (seen.activated) this.post(roomId, 'system', `반복 작업을 스킬로 등록했어요 · ${seen.item.name} (${seen.item.count}번째). 과제·기억 → 스킬에서 고치거나 지울 수 있어요.`, { kind: 'memory', skill: seen.item.id });
      if (seen.archived.length) this.post(roomId, 'system', `오래 안 쓴 스킬을 보관했어요 · ${seen.archived.join(', ')}`, { kind: 'memory' });
      this.bus.emit('skills', {});
    }
    return applied;
  }

  applyCuration(roomId, j) {
    let count = 0;
    const arr = (x) => (Array.isArray(x) ? x : []);
    for (const text of arr(j.user_add)) if (this.memory.add('user', { text }, { save: false })) count++;
    for (const text of arr(j.notes_add)) if (this.memory.add('notes', { text }, { save: false })) count++;
    for (const p of arr(j.projects_upsert)) {
      if (!p?.name) continue;
      const exist = this.memory.findProject(p.name);
      if (exist) this.memory.update('projects', exist.id, { desc: p.desc || exist.desc, status: p.status || exist.status, note: p.note }, { save: false });
      else this.memory.add('projects', { name: p.name, desc: p.desc, status: p.status, notes: p.note ? [p.note] : [] }, { save: false });
      count++;
    }
    for (const t of arr(j.tasks_add)) {
      if (!t?.title) continue;
      const proj = this.memory.findProject(t.project);
      if (this.memory.add('tasks', { title: t.title, due: t.due, projectId: proj?.id, source: this.store.getRoom(roomId)?.name || '' }, { save: false })) count++;
    }
    for (const id of arr(j.tasks_done)) if (this.memory.update('tasks', id, { status: 'done' }, { save: false })) count++;
    if (j.room_summary) this.memory.data.roomSummaries[roomId] = { text: String(j.room_summary).slice(0, 600), ts: Date.now() };
    this.memory.save();
    return { count };
  }
}

function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

module.exports = { Orchestrator, VERDICT_RE, STANCE_RE, MODES };
