'use strict';
// 사용자 프로필 + AI 프로필(페르소나) + 앱 설정. Hermes의 SOUL.md / personalities 를 사이트에서 편집하는 구조.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Hermes 의 personalities 를 벤치마킹한 성격 프리셋
const PERSONALITIES = {
  default: { label: '기본', text: '' },
  concise: { label: '간결', text: '핵심만 짧게 말한다. 불필요한 서론과 요약을 붙이지 않는다.' },
  critic: { label: '직설 비평가', text: '아첨 없이 직설적으로 비평한다. 약점과 리스크를 먼저 짚고, 근거를 댄다.' },
  mentor: { label: '따뜻한 상사', text: '따뜻하지만 명확한 직장 상사 톤. 방향을 제시하고, 다음 행동을 구체적으로 알려준다.' },
  teacher: { label: '선생님', text: '개념을 예시와 함께 차근차근 설명한다. 상대가 이해했는지 짚어가며 말한다.' },
  creative: { label: '크리에이티브', text: '틀을 벗어난 발상을 과감하게 제안한다. 레퍼런스와 비유를 적극 활용한다.' },
  technical: { label: '기술 전문가', text: '정확한 기술 용어와 구체적인 수치·절차로 설명한다.' },
  designer: { label: '디자이너', text: '디자인 관점(사용자, 맥락, 형태, 소재, 브랜드)에서 생각하고, 디자인 용어는 영어를 병기한다.' },
};

// 스튜디오 역할: 진행 흐름에서 누가 무엇을 맡는지. 이름이 아니라 이 값으로 역할을 찾는다.
const STUDIO_ROLES = {
  '': { label: '없음', desc: '스튜디오 흐름에서 맡는 단계 없음' },
  pm: { label: 'PM', desc: '요청 분류 · 브리프 · 결정 카드 · 보고' },
  research: { label: '리서처', desc: '팩트시트 (라벨 · 출처)' },
  concept: { label: '컨셉터', desc: '성격이 다른 방향 3안' },
  critic: { label: '크리틱', desc: '내 기준으로 채점 · 시안 비평' },
  producer: { label: '프로듀서', desc: '유일한 제작자 · 시안과 확정본' },
  verifier: { label: '검증', desc: '사실 · 숫자 · 완료 기준' },
};

// 역할별 SOUL. 역할 / 맡는 산출물 / 하지 않는 일 / 출력 원칙 / 쓰는 스킬 구조로 경계를 분명히 한다.
function soulFor(role, name, user = '나') {
  const S = {
    pm: `당신은 "${name}", ${user}가 디렉터인 디자인 스튜디오의 PM이다.
[맡는 것] 요청 분류(실행형·사고형·학습형), 브리프, 결정 카드, 프로젝트 보고.
[하지 않는 것] 내용을 직접 만들거나 디자인 의견을 내지 않는다. 팀원의 일을 대신하지 않는다.
[원칙] 결정은 디렉터(${user})가 한다. 선택지는 30초 안에 고를 수 있게 짧게. 이견은 지우지 말고 드러낸다. 이미 기억에 답이 있으면 다시 묻지 않는다.`,
    research: `당신은 "${name}", 스튜디오의 리서처다.
[맡는 것] 방향 판단에 필요한 사실만 모은 팩트시트.
[하지 않는 것] 디자인 방향을 제안하지 않는다. 출처 없는 사실을 확정하지 않는다.
[원칙] 모든 사실에 라벨(측정·파생·미확인)과 출처(매체·날짜·링크)를 붙인다. 해석은 "해석"이라고 표시하고 3줄을 넘기지 않는다. 디렉터의 가설을 지지하는 사실과 흔드는 사실을 똑같이 찾는다.
[스킬] 근거 라벨·출처 규칙이 있는 스킬이 설치되어 있으면 그 규칙을 따른다.`,
    concept: `당신은 "${name}", 스튜디오의 컨셉터다.
[맡는 것] 서로 성격이 확실히 다른 방향안 3개 (가설 확장 · 가설 반박 · 와일드카드).
[하지 않는 것] 실현 가능성으로 미리 걸러내지 않는다. 다른 팀원 의견에 맞추지 않는다.
[원칙] 각 안은 한 줄 컨셉으로 설명될 만큼 선명해야 한다. 실재하는 레퍼런스(디자이너·프로젝트·브랜드)를 근거로 든다. 비슷한 안 3개는 실패다.`,
    critic: `당신은 "${name}", 스튜디오의 크리틱이다.
[맡는 것] 디렉터의 "내 기준"으로 방향안을 채점하고, 시안을 비평한다.
[하지 않는 것] 직접 다시 만들거나 새 안을 내지 않는다. 칭찬으로 시작하지 않는다.
[원칙] 점수에는 근거 한 줄. 지적은 "무엇을 → 어떻게"로. 사용자·맥락·형태·소재·제조·브랜드 관점. 디자인 용어는 영어를 병기한다.`,
    producer: `당신은 "${name}", 스튜디오의 프로듀서이자 유일한 제작자다.
[맡는 것] 디렉터가 고른 방향으로 실제 결과물(피그마·노션·문서)을 만들고, 컨펌 후 확정한다.
[하지 않는 것] 방향을 바꾸지 않는다. 확정본을 덮어쓰지 않는다(시안은 따로).
[원칙] 미확인 사실은 확정 표현으로 쓰지 않는다. 내가 내린 판단은 디렉터가 확인할 수 있게 보고에 남긴다.
[스킬] 장표·판넬·문체 가이드처럼 사용자가 설치한 디자인·문서 스킬이 있으면 반드시 먼저 확인하고 적용한다.`,
    verifier: `당신은 "${name}", 스튜디오의 검증 담당이다.
[맡는 것] 사실·숫자·출처·완료 기준 충족 여부.
[하지 않는 것] 취향과 디자인 판단을 평가하지 않는다. 새 조사나 범위를 요구하지 않는다.
[원칙] 막는 문제만, 각 한 줄로. 문제가 없으면 없다고 한 줄로 끝낸다.`,
  };
  return S[role] || '';
}

// 새 페르소나를 빠르게 만들기 위한 템플릿. {name} 은 이름, {user} 는 사용자 이름으로 바뀐다.
const PERSONA_TEMPLATES = [
  { id: 'pm', studioRole: 'pm', name: '플랜', title: 'PM', emoji: '🗂️', color: '#10A37F', personality: 'concise', blurb: '요청 분류·브리프·결정 카드' },
  { id: 'research', studioRole: 'research', name: '서치', title: '리서처', emoji: '🔎', color: '#30B0C7', personality: 'technical', blurb: '출처·라벨이 붙은 팩트시트' },
  { id: 'concept', studioRole: 'concept', name: '반짝', title: '컨셉터', emoji: '💡', color: '#FF9F0A', personality: 'creative', blurb: '성격이 다른 방향 3안' },
  { id: 'critic', studioRole: 'critic', name: '레이', title: '크리틱', emoji: '🎨', color: '#BF5AF2', personality: 'designer', blurb: '내 기준으로 채점·비평' },
  { id: 'producer', studioRole: 'producer', name: '메이커', title: '프로듀서', emoji: '🛠️', color: '#D97757', personality: 'default', blurb: '시안·확정본을 실제로 제작' },
  { id: 'verifier', studioRole: 'verifier', name: '체크', title: '검증', emoji: '🔍', color: '#5E5CE6', personality: 'critic', blurb: '사실·숫자·완료 기준 검증' },
].map((t) => ({ ...t, soul: soulFor(t.studioRole, '{name}', '{user}') }));

const PERMISSIONS = {
  read: { label: '읽기 전용', desc: '파일 읽기·검색·웹 검색만', claude: { allow: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], deny: ['Bash', 'Edit', 'Write', 'NotebookEdit'] }, codex: 'read-only' },
  edit: { label: '파일 편집', desc: '작업 폴더 안 파일 생성·수정 허용', claude: { allow: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Edit', 'Write'], deny: ['Bash'] }, codex: 'workspace-write' },
  full: { label: '전체 권한', desc: '터미널 명령 실행까지 허용 (주의)', claude: { allow: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Edit', 'Write', 'Bash'], deny: [] }, codex: 'danger-full-access' },
};

// 팀 작업(크리틱·리서치 등)의 기본 모델. 설정에서 바꿀 수 있고, 로직은 이 이름에 묶이지 않는다.
const TEAM_MODEL = 'claude-sonnet-5-5';

// Codex 모델 목록: 이 컴퓨터의 Codex 가 받아 둔 목록(계정에서 쓸 수 있는 모델)을 읽는다. 없으면 기본 목록을 쓴다.
function codexModels() {
  const base = [{ id: '', label: '기본값', desc: 'Codex가 권하는 모델 · 추천' }];
  const fallback = [...base, { id: 'gpt-6-astra', label: 'GPT-6 Astra', desc: '가장 강력' }];
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
    const list = (JSON.parse(fs.readFileSync(file, 'utf8')).models || []).filter((m) => m.slug && m.visibility === 'list').slice(0, 6);
    if (!list.length) return fallback;
    const ko = (d = '') => (/frontier|most demanding/i.test(d) ? '가장 강력' : /fast|afford|efficient/i.test(d) ? '빠르고 저렴' : /previous|older|legacy/i.test(d) ? '이전 세대' : /balanced/i.test(d) ? '균형' : '');
    return [...base, ...list.map((m) => ({ id: m.slug, label: String(m.display_name || m.slug).replace(/-/g, ' '), desc: ko(m.description) || 'Codex 모델' }))];
  } catch { return fallback; }
}

const MODELS = {
  claude: [
    { id: '', label: '기본값', desc: 'Claude Code 설정을 따름' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1', desc: '가장 강력 · 토큰 많이 씀' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', desc: '추천 · 똑똑하고 균형' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', desc: '팀 작업 기본 · 빠르고 저렴' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', desc: '빠르고 저렴' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', desc: '가장 빠르고 저렴' },
  ],
  codex: codexModels(),
  mock: [{ id: '', label: '테스트용', desc: '요금 없음' }],
};
const EFFORTS = ['', 'low', 'medium', 'high'];

const AGENT_FIELDS = ['studioRole', 'name', 'title', 'avatar', 'emoji', 'color', 'engine', 'model', 'effort', 'fallbackModel', 'personality', 'soul', 'permission', 'plugins', 'useMemory'];

class Profiles {
  constructor(dataDir, seedPath) {
    this.file = path.join(dataDir, 'profiles.json');
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = seed(seedPath);
      this.save();
    }
    this.data.settings = { autoMemory: true, dataConsent: false, teamModel: TEAM_MODEL, critiqueModels: { read: TEAM_MODEL, lens: TEAM_MODEL, check: TEAM_MODEL, locate: TEAM_MODEL, synth: TEAM_MODEL }, curatorModel: 'claude-haiku-4-5-20251001', tunnelAuto: false, tunnelProvider: 'auto', ...this.data.settings };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  get user() { return this.data.user; }
  get settings() { return this.data.settings; }
  agents() { return this.data.agents; }
  agent(id) { return this.data.agents.find((a) => a.id === id); }
  map() { return Object.fromEntries(this.data.agents.map((a) => [a.id, a])); }

  updateUser(patch) {
    if (typeof patch.name === 'string' && patch.name.trim()) this.data.user.name = patch.name.trim().slice(0, 30);
    if (patch.avatar !== undefined) this.data.user.avatar = cleanAvatar(patch.avatar);
    if (typeof patch.bio === 'string') this.data.user.bio = patch.bio.slice(0, 500);
    this.save();
    return this.data.user;
  }

  updateSettings(patch) {
    for (const k of ['autoMemory', 'tunnelAuto', 'dataConsent']) if (typeof patch[k] === 'boolean') this.data.settings[k] = patch[k];
    // 크리틱 단계별 모델: 비우면 그 단계를 맡은 AI 의 모델을 쓴다. 모델 목록에 있는 값만 받는다.
    if (patch.critiqueModels && typeof patch.critiqueModels === 'object') {
      const known = new Set(Object.values(MODELS).flat().map((m) => m.id));
      const next = {};
      for (const step of ['read', 'lens', 'check', 'locate', 'synth']) {
        const v = patch.critiqueModels[step] ?? this.data.settings.critiqueModels?.[step];
        if (typeof v === 'string' && v && known.has(v)) next[step] = v;
      }
      this.data.settings.critiqueModels = next;
    }
    if (typeof patch.curatorModel === 'string') this.data.settings.curatorModel = patch.curatorModel;
    if (typeof patch.teamModel === 'string' && (!patch.teamModel || MODELS.claude.some((m) => m.id === patch.teamModel))) this.data.settings.teamModel = patch.teamModel;
    if (['auto', 'tailscale', 'cloudflare'].includes(patch.tunnelProvider)) this.data.settings.tunnelProvider = patch.tunnelProvider;
    if (typeof patch.onboarded === 'boolean') this.data.settings.onboarded = patch.onboarded;
    if (typeof patch.tagline === 'string') this.data.settings.tagline = patch.tagline.trim().slice(0, 90);
    if (typeof patch.primaryAgent === 'string' && this.agent(patch.primaryAgent)) this.data.settings.primaryAgent = patch.primaryAgent;
    this.save();
    return this.data.settings;
  }

  createAgent(input) {
    const a = normalizeAgent({
      id: `a-${crypto.randomUUID().slice(0, 6)}`,
      name: '새 프로필', title: '', emoji: '✨', color: randomColor(), engine: 'claude', model: '', effort: '',
      personality: 'default', soul: '', permission: 'read', plugins: [], useMemory: true, avatar: null,
    }, input);
    this.data.agents.push(a);
    this.save();
    return a;
  }

  updateAgent(id, patch) {
    const i = this.data.agents.findIndex((a) => a.id === id);
    if (i < 0) return null;
    this.data.agents[i] = normalizeAgent(this.data.agents[i], patch);
    this.save();
    return this.data.agents[i];
  }

  deleteAgent(id) {
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    this.save();
  }
}

function normalizeAgent(base, patch = {}) {
  const a = { ...base };
  for (const k of AGENT_FIELDS) if (patch[k] !== undefined) a[k] = patch[k];
  a.name = String(a.name || '이름 없음').trim().slice(0, 20);
  a.title = String(a.title || '').slice(0, 30);
  a.soul = String(a.soul || '').slice(0, 8000);
  a.emoji = String(a.emoji || '').slice(0, 4);
  a.color = /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#8e8e93';
  if (!['claude', 'codex', 'mock'].includes(a.engine)) a.engine = 'claude';
  a.model = String(a.model || '').slice(0, 80);
  a.fallbackModel = String(a.fallbackModel || '').slice(0, 80);
  if (!EFFORTS.includes(a.effort)) a.effort = '';
  if (!PERSONALITIES[a.personality]) a.personality = 'default';
  if (!PERMISSIONS[a.permission]) a.permission = 'read';
  if (!STUDIO_ROLES[a.studioRole || '']) a.studioRole = '';
  a.studioRole ||= '';
  a.plugins = Array.isArray(a.plugins) ? a.plugins.map(String).slice(0, 30) : [];
  a.useMemory = a.useMemory !== false;
  a.avatar = cleanAvatar(a.avatar);
  return a;
}

function cleanAvatar(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 400_000) return v;
  return null;
}

function randomColor() {
  const palette = ['#D97757', '#10A37F', '#5E5CE6', '#FF9F0A', '#30B0C7', '#BF5AF2', '#FF375F', '#8E8E93'];
  return palette[Math.floor(Math.random() * palette.length)];
}

// 첫 실행: agents.json 을 새 구조로 옮긴다.
function seed(seedPath) {
  let cfg = { agents: [] };
  try { cfg = JSON.parse(fs.readFileSync(seedPath, 'utf8')); } catch { /* 없음 */ }
  const agents = (cfg.agents || []).map((a) => normalizeAgent({
    id: a.id, name: a.name, title: a.title, emoji: a.emoji, color: a.color, engine: a.engine, model: a.model || '',
    effort: '', personality: a.role === 'reviewer' ? 'critic' : 'default', soul: a.persona || '', permission: 'read', plugins: [], useMemory: true,
  }));
  return { user: { name: cfg.userName || '나', avatar: null, bio: '' }, agents, settings: {} };
}

module.exports = { Profiles, PERSONALITIES, PERMISSIONS, MODELS, EFFORTS, PERSONA_TEMPLATES, STUDIO_ROLES, soulFor };
