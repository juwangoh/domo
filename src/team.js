'use strict';
// 팀 서비스: 기본은 AI 1명이 답하고, 아래 순간에만 팀을 부른다 (docs/PRODUCT.md 근거).
//  /크리틱  크리틱 리허설 — 교수·사용자·디테일 시점이 서로를 보지 않고 독립 채점 → 종합(점수표·고칠 점 Top 3·예상 질문)
//  /리서치  데스크리서치 — 리서처 팩트시트(라벨·출처) → 다른 회사 모델(Codex)이 교차 검증
//  /검증    사실 검증 — 직전 AI 답을 Codex 가 한 번 검증
//  /컨셉    컨셉 3안 — 스튜디오 흐름(내 가설 → 독립 발산 → 내 기준 채점 → 결정 카드)
//  /비교    블라인드 비교 — 1명 답과 팀 답을 섞어 보여주고 사용자가 고른다 (효과를 실측하기 위한 장치)

const COMMANDS = {
  critique: { re: /^\s*\/크리틱/, label: '크리틱 리허설', desc: '작업물을 교수·사용자·디테일 시점으로 독립 채점' },
  concept: { re: /^\s*\/컨셉/, label: '컨셉 3안', desc: '내 가설에서 출발해 서로 다른 방향 3안' },
  research: { re: /^\s*\/리서치/, label: '데스크리서치', desc: '출처·라벨이 붙은 팩트시트 + 교차 검증' },
  verify: { re: /^\s*\/검증/, label: '사실 검증', desc: '직전 답을 다른 회사 모델로 한 번 더 확인' },
  compare: { re: /^\s*\/비교/, label: '1명 vs 팀 비교', desc: '같은 요청을 두 방식으로 받아 블라인드로 고르기' },
};

function commandOf(text) {
  for (const [id, c] of Object.entries(COMMANDS)) if (c.re.test(text)) return id;
  return null;
}
// 정리 글에서 "다음 작업" 목록을 떼어 버튼으로 만든다. 못 찾으면 기본 제안을 쓴다.
const NEXT_KINDS = { 컨셉: ['컨셉 3안', '/컨셉 '], 크리틱: ['크리틱 리허설', '/크리틱 '], 리서치: ['더 조사하기', '/리서치 '], 질문: ['이어서 묻기', ''] };
function parseNext(text, request = '') {
  const src = String(text || '');
  const at = src.search(/^#{1,4}\s*다음 작업\s*$/m);
  const next = [];
  for (const m of (at >= 0 ? src.slice(at) : '').matchAll(/^\s*(?:\d+[.)]|[-*])\s*\[(컨셉|크리틱|리서치|질문)\]\s*(.+)$/gm)) {
    const line = m[2].replace(/[*_`]/g, '').trim().slice(0, 200);
    if (line && next.length < 3) next.push({ kind: NEXT_KINDS[m[1]][0], text: line, send: NEXT_KINDS[m[1]][1] + line });
  }
  if (!next.length) {
    next.push({ kind: '컨셉 3안', text: '이 조사를 바탕으로 컨셉 잡기', send: `/컨셉 ${request}`.trim() });
    next.push({ kind: '더 조사하기', text: '아직 모르는 것을 더 조사하기', send: '/리서치 ' });
  }
  return { body: (at >= 0 ? src.slice(0, at) : src).trim() || src.trim(), next };
}

const stripCommand = (text) => String(text).replace(/^\s*\/\S+\s*/, '').trim();

const DEFAULT_RUBRIC = ['문제 정의 · 왜 이 문제인가', '리서치 근거 · 주장에 근거가 있는가', '컨셉 명확성 · 한 문장으로 설명되는가', '형태·디테일 · 완성도와 일관성', '전달력 · 판넬/발표에서 바로 읽히는가'];

// 사용자가 "기준:" 아래에 적은 줄을 교수 기준표로 쓴다.
function rubricFrom(text, principles = '') {
  const m = String(text).match(/기준\s*[:：]\s*([\s\S]+)/);
  if (m) {
    const items = m[1].split(/\n|,|·(?=\s)/).map((x) => x.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter((x) => x.length > 1).slice(0, 8);
    if (items.length) return { items, source: '사용자 기준표' };
  }
  return { items: DEFAULT_RUBRIC, source: principles ? '기본 기준표 + 내 기준' : '기본 기준표' };
}

const LENSES = [
  { id: 'professor', label: '교수 시점', focus: '평가 기준표에 비추어 논리·근거·완성도를 엄격히 본다. 발표 때 교수가 실제로 물을 질문을 떠올린다.' },
  { id: 'user', label: '사용자 시점', focus: '이 디자인을 실제로 쓰거나 보는 사람의 맥락에서 본다. 누가, 언제, 왜 쓰는지가 설득되는지 본다.' },
  { id: 'detail', label: '디테일 시점', focus: '형태·비례·소재·타이포·레이아웃 같은 시각적 완성도와 일관성을 본다. 고칠 부분을 구체적인 위치로 짚는다.' },
];

const NO_FLATTERY = '칭찬으로 시작하지 마세요. 다른 사람의 의견은 모르는 상태에서 당신의 시점으로만 판단하세요. 한국어, 디자인 용어는 영어 병기.';

const prompts = {
  lens: ({ request, rubric, principles, lens, files }) => `[팀 서비스: 크리틱 리허설 · ${lens.label}]
## 학생의 작업 설명
${request || '(설명 없음 — 첨부를 보고 판단)'}
${files ? `## 첨부\n${files}\n` : ''}## 평가 기준표 (${rubric.source})
${rubric.items.map((x, i) => `${i + 1}. ${x}`).join('\n')}
${principles ? `## 학생 본인의 기준\n${principles}\n` : ''}
당신의 시점: ${lens.focus}
출력 형식:
| 기준 | 점수(1~5) | 근거 한 줄 |
(기준표의 모든 항목)
### 가장 큰 문제 2개
- 무엇이 → 어떻게 고칠지
### 이 시점에서 나올 질문 2개
- 질문
${NO_FLATTERY}`,

  synth: ({ request, rubric, reviews }) => `[팀 서비스: 크리틱 리허설 · 종합]
## 작업 설명
${request || '(첨부 참고)'}
## 기준표
${rubric.items.map((x, i) => `${i + 1}. ${x}`).join('\n')}
## 세 시점의 독립 채점
${reviews.map((r) => `### ${r.label}\n${r.text}`).join('\n\n')}
세 채점을 종합해 학생이 크리틱 전에 바로 쓸 수 있는 리포트를 쓰세요. 새 의견을 지어내지 말고, 시점 간 점수가 크게 다르면 그 차이를 드러내세요.
형식:
## 점수표
| 기준 | 교수 | 사용자 | 디테일 | 평균 |
## 고칠 점 Top 3
1. (가장 점수를 많이 올리는 것부터 · 무엇을 → 어떻게)
## 예상 질문과 답변 준비
- 질문 → 준비할 답의 방향 한 줄
## 다음 행동
- [ ] 할 일 (담당: 나)`,

  facts: ({ request, principles, about }) => `[팀 서비스: 데스크리서치]
## 조사 요청
${request}
${about ? `## 사용자 상황\n${about}\n` : ''}${principles ? `## 사용자의 기준\n${principles}\n` : ''}방향을 판단하는 데 필요한 사실만 모아 팩트시트를 쓰세요. 웹 검색으로 확인한 사실만 확정 표현으로 쓰세요.
${about ? '일반론으로 끝내지 말고, 위 사용자 상황(지역·전공·준비 중인 일·기한)에 직접 해당하는 사실을 먼저 찾으세요. 상황과 무관한 요청이면 억지로 엮지 마세요.\n' : ''}해석에는 이 사실이 사용자의 지금 작업에 무엇을 뜻하는지 쓰세요.
형식:
| # | 사실 | 라벨(측정·파생·미확인) | 출처(매체·날짜·링크) |
## 해석 (3줄 이내, "해석"임을 밝힐 것)
## 더 확인이 필요한 것`,

  crosscheck: ({ request, facts }) => `[팀 서비스: 데스크리서치 · 교차 검증]
## 조사 요청
${request}
## 다른 AI가 만든 팩트시트
${facts}
각 행의 사실·숫자·출처가 맞는지 확인하세요. 확인한 것은 ✓, 틀리거나 출처와 다른 것은 ✗와 바른 내용, 확인할 수 없는 것은 ?로 표시하세요. 새 조사 범위를 넓히지 마세요.
형식:
| # | 판정 | 메모 |
마지막 줄: "판정: 통과" 또는 "판정: 수정필요"`,

  wrap: ({ request, facts, check, about, principles, unverified }) => `[팀 서비스: 데스크리서치 · 정리]
## 조사 요청
${request}
${about ? `## 사용자 상황\n${about}\n` : ''}${principles ? `## 사용자의 기준\n${principles}\n` : ''}## 팩트시트
${facts}
${check ? `## 교차 검증 결과\n${check}\n` : ''}위 조사를 사용자가 바로 다음 작업으로 넘어갈 수 있게 정리하세요. 새 사실을 지어내지 말고 팩트시트에 있는 것만 쓰세요.${check ? ' 교차 검증에서 ✗·?로 표시된 내용은 고친 값으로 쓰거나 "미확인"이라고 밝히세요.' : ''}${unverified ? ' 교차 검증을 거치지 않았으므로 확정 표현을 아끼세요.' : ''}
형식:
## 한눈에
- (핵심 3줄 이내 · 숫자와 기한은 그대로)
## 내 작업에 뜻하는 것
- (사용자 상황에 비추어 2~3줄 · "해석"임을 밝힐 것)
## 아직 모르는 것
- (없으면 "없음")
## 다음 작업
1. [컨셉] (이 조사를 바탕으로 컨셉을 잡을 때 팀에 보낼 요청문 한 줄)
2. [리서치] (더 파야 할 주제 한 줄)
3. [질문] (지금 바로 물어볼 만한 질문 한 줄)
"다음 작업"은 2~3개만, 위 대괄호 종류([컨셉]·[크리틱]·[리서치]·[질문]) 중에서 골라 사용자 상황에 맞는 구체적인 문장으로 쓰세요.`,

  verify: ({ question, answer }) => `[팀 서비스: 사실 검증]
## 사용자 질문
${question || '(앞 대화 참고)'}
## 검증할 답
${answer}
이 답을 틀리게 만드는 문제(사실 오류, 숫자·계산 실수, 존재하지 않는 출처·사례, 질문 누락)만 최대 3개, 각 한 줄로 쓰고 바른 내용을 붙이세요. 문체나 더 나은 방법 제안은 쓰지 마세요. 문제가 없으면 "문제 없음" 한 줄.
마지막 줄: "판정: 통과" 또는 "판정: 수정필요"`,

  single: ({ request }) => `${request}`,

  draft: ({ request }) => `[블라인드 비교 · 팀 초안]
${request}
다른 AI도 같은 요청에 따로 답합니다. 남의 답을 의식하지 말고 당신의 최선의 답을 쓰세요.`,

  merge: ({ request, drafts }) => `[블라인드 비교 · 팀 종합]
## 요청
${request}
## 서로를 보지 않고 쓴 초안
${drafts.map((d, i) => `### 초안 ${i + 1}\n${d}`).join('\n\n')}
두 초안을 비교해 사실 충돌은 바로잡고, 더 나은 부분만 골라 하나의 최종 답을 쓰세요. 초안이나 비교 과정은 언급하지 말고, 사용자에게 바로 주는 답만 쓰세요.`,
};

// 비교 결과를 과제 유형별로 묶기 위한 간단한 분류
function taskKind(text) {
  const t = String(text);
  if (/크리틱|피드백|평가|채점|비평/.test(t)) return '크리틱';
  if (/컨셉|아이디어|방향|브레인|발상|주제|추천/.test(t)) return '컨셉';
  if (/조사|리서치|사례|통계|자료|출처/.test(t)) return '리서치';
  if (/글|문구|카피|대본|소개|캡션/.test(t)) return '글쓰기';
  return '일반';
}

// ── 온보딩: 답을 바탕으로 팀 페르소나와 첫 작업 추천을 만든다 ─────────────
const TONES = {
  direct: { label: '직설적으로', personality: 'critic', text: '아첨 없이 직설적으로 말한다. 약점부터 짚고 근거를 댄다.' },
  warm: { label: '따뜻하지만 명확하게', personality: 'mentor', text: '따뜻하지만 명확하게 말한다. 다음 행동을 구체적으로 알려준다.' },
  teach: { label: '차근차근 설명', personality: 'teacher', text: '개념을 예시와 함께 차근차근 설명한다.' },
  brief: { label: '짧고 빠르게', personality: 'concise', text: '핵심만 짧게 말한다.' },
};

const TASK_OPTIONS = [
  { id: 'critique', label: '과제 크리틱 준비', suggestion: { title: '다음 크리틱 리허설', service: 'critique', prompt: '/크리틱 이번 주 크리틱에 낼 작업이야. (작업 사진이나 PDF를 첨부하고 설명을 적어줘)\n기준: ' } },
  { id: 'concept', label: '컨셉·아이디어 발상', suggestion: { title: '막힌 컨셉 뚫기', service: 'concept', prompt: '/컨셉 지금 막혀 있는 프로젝트 주제: ' } },
  { id: 'research', label: '데스크리서치', suggestion: { title: '출처 있는 리서치', service: 'research', prompt: '/리서치 조사하고 싶은 주제: ' } },
  { id: 'writing', label: '판넬·발표 문구', suggestion: { title: '판넬 문구 다듬기', service: 'chat', prompt: '판넬에 들어갈 문구를 다듬고 싶어. 지금 초안: ' } },
  { id: 'portfolio', label: '포트폴리오', suggestion: { title: '포트폴리오 구성', service: 'chat', prompt: '포트폴리오에 넣을 프로젝트 순서와 각 장의 핵심 메시지를 같이 정리하자. 프로젝트 목록: ' } },
  { id: 'schedule', label: '마감·일정 관리', suggestion: { title: '이번 주 마감 정리', service: 'chat', prompt: '이번 주 과제 마감을 정리하고 우선순위를 정해줘. 과제 목록: ' } },
];

function cleanAnswers(a = {}) {
  const s = (v, n = 200) => String(v || '').trim().slice(0, n);
  return {
    job: s(a.job, 60),
    field: s(a.field, 80),
    work: s(a.work, 300),
    interests: s(a.interests, 300),
    hobbies: s(a.hobbies, 200),
    tasks: (Array.isArray(a.tasks) ? a.tasks : []).filter((t) => TASK_OPTIONS.some((o) => o.id === t)).slice(0, 6),
    tone: TONES[a.tone] ? a.tone : 'direct',
    goal: s(a.goal, 300),
  };
}

// 모든 페르소나 SOUL 끝에 붙는 "이 사용자에 대한 맥락"
function userContext(A, userName) {
  const lines = [
    A.job || A.field ? `- ${userName}: ${[A.job, A.field].filter(Boolean).join(' · ')}` : '',
    A.work ? `- 하는 일: ${A.work}` : '',
    A.interests ? `- 관심사: ${A.interests}` : '',
    A.hobbies ? `- 취미: ${A.hobbies}` : '',
    A.goal ? `- 지금 목표: ${A.goal}` : '',
    `- 원하는 피드백 톤: ${TONES[A.tone].label} — ${TONES[A.tone].text}`,
  ].filter(Boolean);
  return `[이 사용자에 대한 맥락]\n${lines.join('\n')}\n예시와 레퍼런스는 이 사용자의 분야·관심사에서 고르세요.`;
}

function userFacts(A) {
  return [
    A.job || A.field ? `직업·전공: ${[A.job, A.field].filter(Boolean).join(' · ')}` : '',
    A.work ? `하는 일: ${A.work}` : '',
    A.interests ? `관심사: ${A.interests}` : '',
    A.hobbies ? `취미: ${A.hobbies}` : '',
    A.goal ? `지금 목표: ${A.goal}` : '',
    `피드백 선호: ${TONES[A.tone].label}`,
  ].filter(Boolean);
}

// 고른 작업을 먼저, 3개가 안 되면 크리틱·컨셉·리서치 순으로 채운다.
function defaultSuggestions(A) {
  const picked = [...new Set([...A.tasks, 'critique', 'concept', 'research'])];
  return picked.slice(0, 3).map((id) => TASK_OPTIONS.find((o) => o.id === id).suggestion);
}

const onboardingPrompt = (A, userName) => `[온보딩 맞춤]
${userContext(A, userName)}
자주 할 작업: ${A.tasks.map((t) => TASK_OPTIONS.find((o) => o.id === t)?.label).join(', ') || '(선택 없음)'}

이 사용자를 돕는 디자인 스튜디오 AI 팀(PM·리서처·컨셉터·크리틱·프로듀서·검증)을 맞춤화하려 합니다. JSON 하나만 출력하세요.
{
  "notes": { "pm": "...", "research": "...", "concept": "...", "critic": "...", "producer": "...", "verifier": "..." },
  "suggestions": [ { "title": "10자 안팎", "service": "critique|concept|research|chat", "prompt": "이 사용자가 바로 보낼 수 있는 첫 메시지 (빈칸은 ':' 뒤에 남김)" } ]
}
- notes: 각 역할이 이 사용자에게 특히 신경 쓸 점 한두 문장 (분야 특유의 기준, 자주 쓰는 레퍼런스 영역 등). 일반론 금지.
- suggestions: 사용자가 고른 작업과 목표에 맞는 첫 작업 3개. 크리틱은 "/크리틱 ", 컨셉은 "/컨셉 ", 리서치는 "/리서치 "로 시작.`;

module.exports = {
  parseNext,
  COMMANDS, commandOf, stripCommand, rubricFrom, LENSES, prompts, taskKind,
  TONES, TASK_OPTIONS, cleanAnswers, userContext, userFacts, defaultSuggestions, onboardingPrompt, DEFAULT_RUBRIC,
};
