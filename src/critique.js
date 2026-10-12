'use strict';
// 크리틱 리허설의 기준·지시서·출력 규격.
//  흐름: ① 읽기 확인(read) → 사용자 수정 → ② 시점별 크리틱(lens ×3) → ③ 검증(check) → ④ 위치 지정(locate) → ⑤ 종합(synth)
//  시점·용도·단계는 모두 데이터로 정의한다 (나중에 시점을 추가하거나 비중을 바꿀 수 있게).
//  모델 이름은 여기에 없다. 어떤 단계에 어떤 모델을 쓸지는 설정(settings.critiqueModels)에서 정한다.

const STEPS = ['read', 'lens', 'check', 'locate', 'synth'];
const STEP_LABEL = { read: '읽기 확인', lens: '시점별 크리틱', check: '검증', locate: '위치 지정', synth: '종합 리포트' };

// 평가 항목과 점수 앵커 (2점·4점은 인접 앵커의 중간)
const CRITERIA = [
  { id: 'problem', label: '문제 정의', anchors: { 1: '문제 없이 결과물만 제시', 3: '문제는 있으나 사이트·사용자 근거와 연결이 약함', 5: '관찰과 수치로 뒷받침된 문제가 솔루션까지 한 줄로 이어짐' } },
  { id: 'research', label: '리서치 근거', anchors: { 1: '출처 없는 주장 위주', 3: '출처는 있으나 가설을 확정처럼 표현한 부분이 있음', 5: '핵심 수치에 출처가 있고 가설은 가설로 표기됨' } },
  { id: 'concept', label: '컨셉 명확성', anchors: { 1: '한 문장으로 설명되지 않음', 3: '한 문장 설명은 되지만 형태·서비스와 연결이 느슨함', 5: '한 문장 컨셉이 모든 장표의 결정을 설명함' } },
  { id: 'form', label: '형태·디테일', anchors: { 1: '형태 근거와 치수가 없음', 3: '형태 논리는 있으나 치수·구조·재료 중 일부 누락', 5: '치수, 구조, 사용 장면까지 검증 가능함' } },
  { id: 'delivery', label: '전달력', anchors: { 1: '장표 순서와 위계가 혼란스러움', 3: '정보는 있으나 텍스트 과다 또는 시선 흐름이 끊김', 5: '이미지 흐름만으로 이야기가 읽힘' } },
];
const CRITERION_LABELS = CRITERIA.map((c) => c.label);

const BEHANCE_CHECKLIST = [
  '완성본인가 (큐레이터는 첫 발행 때 한 번만 검토한다)',
  '이미지가 3장 이상인가 (3장 미만은 큐레이터에게 노출되지 않는다 · 권장 5~15장)',
  '이미지 폭이 1400px인가',
  '커버에 텍스트가 없는가',
  '카테고리가 결과물이 아니라 본인 역할 기준인가',
  '태그가 적고 정확한가, 툴과 협업자 크레딧이 기입됐는가',
  '워터마크가 작업을 가리지 않는가',
  '과제 판넬을 그대로 올리지 않았는가 (A3 판넬을 1400px로 줄이면 본문이 읽히지 않는다 → 히어로·다이어그램·디테일·목업으로 재구성 권장)',
];
const CONTEST_CHECKLIST = [
  '아이디어: 무엇이 새로운지 한 문장으로 말할 수 있는가',
  '형태: 형태가 아이디어를 설명하는가, 꾸밈에 그치지 않는가',
  '기능: 실제로 작동하고 쓰이는 장면이 검증 가능한가',
  '차별성: 이미 있는 것과 무엇이 다른지 비교가 제시됐는가',
  '지속가능성: 재료·제작·사용·폐기 중 어디에서 부담을 줄이는지 근거가 있는가',
];

// 용도: 평가 항목과 출력 형식은 같고, 항목별 비중과 "누가 보는가"만 바뀐다.
const PURPOSES = {
  class: {
    label: '수업 제출',
    weights: { problem: 20, research: 25, concept: 20, form: 20, delivery: 15 },
    lenses: [
      { id: 'professor', label: '교수 시점', focus: '과제를 낸 교수로서 논리·근거·완성도를 엄격히 본다. 발표 때 실제로 물을 질문을 떠올린다.' },
      { id: 'user', label: '사용자 시점', focus: '이 서비스·제품을 실제로 쓰는 사람의 맥락에서 본다. 누가, 언제, 왜 쓰는지가 설득되는지 본다.' },
      { id: 'detail', label: '디테일 시점', focus: '형태·비례·소재·타이포·레이아웃 같은 시각적 완성도와 장표 간 일관성을 본다.' },
    ],
    notes: [],
    checklist: [],
  },
  contest: {
    label: '공모전',
    weights: { problem: 15, research: 10, concept: 25, form: 30, delivery: 20 },
    lenses: [
      { id: 'professor', label: '심사위원 시점', focus: '수많은 출품작을 짧은 시간에 보는 공모전 심사위원으로서 본다. 아이디어의 새로움과 완성도가 첫 장에서 읽히는지 본다.' },
      { id: 'user', label: '사용자 시점', focus: '이 서비스·제품을 실제로 쓰는 사람의 맥락에서 본다. 기능이 실제 장면에서 작동하는지 본다.' },
      { id: 'detail', label: '디테일 시점', focus: '형태·비례·소재·타이포·레이아웃의 완성도를 보고, 아래 공모전 체크를 함께 확인한다.' },
    ],
    notes: [
      '컨셉 명확성을 볼 때 차별성(이미 있는 것과 무엇이 다른가)을 하위 체크로 함께 본다.',
      '형태·디테일을 볼 때 지속가능성(재료·제작·사용·폐기의 부담)을 하위 체크로 함께 본다.',
    ],
    checklist: CONTEST_CHECKLIST,
  },
  behance: {
    label: '비헨스',
    weights: { problem: 10, research: 5, concept: 20, form: 35, delivery: 30 },
    lenses: [
      { id: 'professor', label: '큐레이터 시점', focus: '비헨스 큐레이터로서 본다. 생각이 깊은 작업인지, 시각적으로 강렬하고 정밀하게 완성됐는지, 보여주는 방식이 좋은지 본다.' },
      { id: 'user', label: '관객 시점', focus: '피드를 스크롤하다 커버를 본 관객으로서 본다. 커버가 멈추게 하는지, 이미지 흐름만으로 이야기가 읽히는지 본다.' },
      { id: 'detail', label: '디테일 시점', focus: '형태·타이포·이미지 품질의 정밀함을 보고, 아래 비헨스 체크리스트를 함께 확인한다.' },
    ],
    notes: [
      '문제 정의는 "작업의 맥락이 설명되는가"로 본다.',
      '컨셉 명확성은 "생각이 깊은 작업인가"로 본다.',
      '형태·디테일은 "시각적으로 강렬한가, 정밀하게 완성됐는가"로 본다.',
      '전달력은 "보여주는 방식, 커버의 흡인력, 이미지 흐름만으로 이야기가 읽히는가"로 본다.',
      '발행 전에는 알 수 없는 커뮤니티 반응은 평가하지 않는다.',
    ],
    checklist: BEHANCE_CHECKLIST,
  },
};

// 진행 단계: 같은 결과물이라도 단계에 따라 지적의 성격이 달라진다.
const STAGES = {
  idea: { label: '아이디어', scores: false, guide: '아이디어 단계다. 결론을 닫는 지적을 하지 않는다. "격차"는 단정 대신 열린 질문으로 쓰고, "개선 방향"은 정답이 아니라 서로 다른 해석과 탐색 방향으로 쓴다. 점수는 매기지 않는다(scores 는 빈 배열).' },
  mid: { label: '중간', scores: true, guide: '중간 단계다. 지금의 방향은 유지한다고 보고, 근거와 구조의 빈틈을 짚는다. 방향 자체를 뒤집는 지적은 꼭 필요할 때만 한다.' },
  final: { label: '최종', scores: true, guide: '최종 단계다. 구체적이고 수렴적인 지적을 한다. 수치와 치수를 검증하고 체크리스트를 전부 적용한다.' },
};

const FIX_TYPES = ['안전', '실험', '절충'];
const EVIDENCE = ['확인된 사실', '추정'];
const SEVERITY = ['높음', '중간', '낮음'];
const VERDICTS = ['맞음', '오판', '애매'];
const REGIONS = ['좌측 상단', '상단', '우측 상단', '좌측', '중앙', '우측', '좌측 하단', '하단', '우측 하단', '전체'];

// "/크리틱 용도:공모전 단계:중간 설명…" 에서 옵션을 읽는다. 없으면 수업 제출 · 최종.
function parseOptions(text) {
  const s = String(text || '');
  const find = (map, key) => {
    const m = s.match(new RegExp(`${key}\\s*[:：]\\s*(\\S+)`));
    return m ? Object.keys(map).find((k) => map[k].label === m[1] || k === m[1]) || null : null;
  };
  const purpose = find(PURPOSES, '용도') || 'class';
  const stage = find(STAGES, '단계') || 'final';
  const request = s.replace(/^\s*\/\S+\s*/, '').replace(/(용도|단계)\s*[:：]\s*\S+\s*/g, '').trim();
  return { purpose, stage, request };
}

// ── 지시서 ─────────────────────────────────────
// 매번 똑같은 긴 문구(루브릭·규칙)는 항상 같은 글자로 맨 앞에 둔다. 캐싱이 되는 환경에서는 이 앞부분이 재사용된다.
const RUBRIC_BLOCK = `## 평가 항목과 점수 앵커 (1~5점)
${CRITERIA.map((c) => `- ${c.label}: 1점 = ${c.anchors[1]} / 3점 = ${c.anchors[3]} / 5점 = ${c.anchors[5]}`).join('\n')}
2점과 4점은 인접한 앵커의 중간으로 판단한다. 같은 결과물이면 언제 채점해도 같은 점수가 나오도록 앵커 문장에 비추어 매긴다.

## 지적을 쓰는 규칙
- 지적은 세 부분으로 쓴다. standard(기대 기준: 어떤 기준에 비추어 문제인가) → gap(격차: 지금 결과물이 그 기준과 어떻게 다른가) → fixes(개선 방향).
- fixes 는 정답 하나가 아니라 서로 다른 방향 2~3개를 한 줄씩 쓴다. "안전" 1개와 "실험" 1개는 반드시, 필요하면 "절충" 1개. 학생이 그대로 베끼지 않고 스스로 해석할 여지를 남긴다.
- evidence_type 은 "확인된 사실"(결과물에 보이거나 사용자가 확인해 준 정보에 근거) 또는 "추정"(결과물에서 추론)이다. 추정에 근거한 지적은 단정형으로 쓰지 않는다("~로 보인다", "~인지 확인이 필요하다").
- 사용자가 직접 확인했다고 적은 사실은 의심하지 말고 확인된 사실로 취급한다.
- 지적은 적게, 가장 중요한 것만 쓴다. 칭찬으로 시작하지 않는다. 한국어로 쓰고 디자인 용어는 영어를 병기한다.`;

const slideList = (slides) => (slides.length
  ? slides.map((s) => `- ${String(s.n).padStart(2, '0')}번: ${s.path}${s.axis ? ' (가장자리에 0~100 좌표축이 붙어 있음)' : ''}`).join('\n')
  : '(첨부 없음 — 설명만으로 판단)');

function contextBlock(C, { files = true } = {}) {
  const P = PURPOSES[C.purpose];
  const i = C.input || {};
  const meta = [i.course && `수업: ${i.course}`, i.field && `분야: ${i.field}`, i.medium && `매체: ${i.medium}`].filter(Boolean).join(' · ');
  return `## 용도: ${P.label}
항목별 비중: ${CRITERIA.map((c) => `${c.label} ${P.weights[c.id]}%`).join(', ')}
${P.notes.map((n) => `- ${n}`).join('\n')}
## 진행 단계: ${STAGES[C.stage].label}
${STAGES[C.stage].guide}
## 학생의 설명
${C.request || '(설명 없음)'}
${meta ? `${meta}\n` : ''}${i.brief ? `## 과제 지침\n${i.brief}\n` : ''}${files ? `## 장표 (번호 순서)\n${slideList(C.slides || [])}\n파일은 Read 도구로 열어 직접 본다.` : `## 장표\n${(C.slides || []).length}장 (이 단계에서는 파일을 열지 않는다. 아래에 정리된 내용만으로 쓴다.)`}`;
}

function understandingBlock(C) {
  const r = C.read?.final || C.read?.ai;
  if (!r) return '';
  const facts = [...(r.facts || []), ...(C.read.confirmedFacts || [])];
  return `## 결과물에 대한 이해 (사용자가 확인·수정함)
- 컨셉: ${r.concept || '-'}
- 사이트·맥락: ${r.context || '-'}
- 타깃 사용자: ${r.target || '-'}
${(r.slides || []).map((s) => `- ${String(s.n).padStart(2, '0')}번 장표: ${s.role}`).join('\n')}
${facts.length ? `### 확인된 사실\n${facts.map((f) => `- ${f}`).join('\n')}\n` : ''}${(C.read.confirmedFacts || []).length ? `### 사용자가 직접 확인한 사실 (의심하지 말 것)\n${C.read.confirmedFacts.map((f) => `- ${f}`).join('\n')}\n` : ''}${(r.assumptions || []).length ? `### 아직 가정인 것\n${r.assumptions.map((f) => `- ${f}`).join('\n')}\n` : ''}`;
}

const prompts = {
  read: (C) => `[크리틱 단계: read] 읽기 확인
크리틱을 하기 전에, 이 결과물을 당신이 어떻게 이해했는지 먼저 정리한다. 평가나 지적은 하지 않는다. 학생이 이 요약을 고친 뒤에 크리틱이 시작된다.
${contextBlock(C)}

JSON 만 출력한다:
{"concept":"컨셉 한 문장","context":"사이트·맥락","target":"타깃 사용자","slides":[{"n":1,"role":"이 장표의 역할 한 줄"}],"facts":["결과물에서 확인된 사실로 보이는 것"],"assumptions":["가정으로 보이는 것"]}
모르는 것은 지어내지 말고 "확인 필요"라고 쓴다. facts 와 assumptions 는 각각 6개 이내.`,

  lens: (C, lens, examples = []) => `[크리틱 단계: lens] 시점별 크리틱 · ${lens.label}
${RUBRIC_BLOCK}

${contextBlock(C)}
${understandingBlock(C)}${PURPOSES[C.purpose].checklist.length && lens.id === 'detail' ? `## ${PURPOSES[C.purpose].label} 체크 (이 시점에서 함께 확인)\n${PURPOSES[C.purpose].checklist.map((x) => `- ${x}`).join('\n')}\n` : ''}${C.principles ? `## 학생 본인의 기준\n${C.principles}\n` : ''}${examples.length ? `## 좋은 지적의 예 (형식과 깊이 참고용 · 내용을 베끼지 말 것)\n${examples.map((e) => `- 기준: ${e.standard} / 격차: ${e.gap}`).join('\n')}\n` : ''}
당신의 시점: ${lens.focus}
다른 시점의 의견은 모르는 상태에서 당신의 시점으로만 판단한다.

JSON 만 출력한다:
{"scores":[{"criterion":"${CRITERION_LABELS.join('|')}","score":1,"reason":"근거 한 줄"}],"issues":[{"criterion":"다섯 항목 중 하나","standard":"기대 기준","gap":"격차","fixes":[{"type":"안전","text":"한 줄"},{"type":"실험","text":"한 줄"}],"evidence_type":"확인된 사실|추정","severity":"높음|중간|낮음","where":"몇 번 장표의 어느 부분인지"}],"questions":["이 시점에서 나올 질문"]}
scores 는 다섯 항목 전부(아이디어 단계면 빈 배열), issues 는 가장 큰 문제 2개, questions 는 2개.`,

  check: (C, auto = []) => `[크리틱 단계: check] 검증
의견이나 취향 판단은 하지 않는다. 결과물 안에서 검증할 수 있는 것만 확인한다.
${contextBlock(C)}
${understandingBlock(C)}
확인할 것:
1. 숫자: 표·그래프·본문의 합계와 단위가 맞는가.
2. 일관성: 같은 숫자·이름·일정이 장표마다 같은가 (예: 조합표 합계와 타임라인 합계가 다른 경우).
${PURPOSES[C.purpose].checklist.length ? `3. ${PURPOSES[C.purpose].label} 체크리스트:\n${PURPOSES[C.purpose].checklist.map((x) => `   - ${x}`).join('\n')}` : '3. 과제 지침에 적힌 필수 요건이 있으면 충족했는가.'}
${auto.length ? `이미 코드로 확인한 항목(다시 판단하지 말 것):\n${auto.map((a) => `- ${a.item}: ${a.result} (${a.note})`).join('\n')}\n` : ''}
JSON 만 출력한다:
{"checks":[{"kind":"숫자|일관성|체크리스트","item":"확인한 것","result":"통과|문제|확인 불가","note":"근거 한 줄","slide":1}]}
문제가 없으면 통과로 적는다. 볼 수 없는 것은 "확인 불가"로 적고 추측하지 않는다. 10개 이내.`,

  locate: (C, issues) => `[크리틱 단계: locate] 위치 지정
아래 지적이 몇 번 장표의 어느 영역에 대한 것인지만 붙인다. 지적의 내용은 고치지 않는다.
## 장표 (번호 순서)
${slideList(C.slides || [])}
파일은 Read 도구로 열어 직접 본다. 가장자리 좌표축은 왼쪽 위가 (0,0), 오른쪽 아래가 (100,100)이다.
## 지적
${issues.map((x) => `- ${x.id}: ${x.gap}${x.where ? ` (힌트: ${x.where})` : ''}`).join('\n')}

JSON 만 출력한다:
{"locations":[{"id":"지적 id","slide":6,"region":"${REGIONS.join('|')}","x":[0,40],"y":[60,100],"target":"가리키는 대상 (예: 범례)"}]}
장표 전체에 대한 지적이면 region 을 "전체"로 하고 x, y 는 생략한다. 어느 장표인지 알 수 없으면 slide 를 null 로 둔다.`,

  synth: (C, { issues, checks, table }) => `[크리틱 단계: synth] 종합 리포트
세 시점의 지적과 검증 결과를 모아 학생이 바로 쓸 수 있게 정리한다. 새 의견을 지어내지 않는다. 도구는 쓰지 않는다.
${contextBlock(C, { files: false })}
## 점수 (시점별 · 가중 평균은 코드가 계산함)
${table || '(아이디어 단계 — 점수 없음)'}
## 세 시점의 지적
${issues.map((x) => `- ${x.id} [${x.viewpoint} · ${x.criterion} · ${x.severity} · ${x.evidence_type}] 기준: ${x.standard} / 격차: ${x.gap}`).join('\n') || '(없음)'}
## 검증 결과
${checks.filter((c) => c.result !== '통과').map((c) => `- [${c.kind}] ${c.item}: ${c.result} — ${c.note}`).join('\n') || '(문제 없음)'}
## 시점별 예상 질문
${(C.questions || []).map((q) => `- (${q.viewpoint}) ${q.text}`).join('\n') || '(없음)'}

JSON 만 출력한다:
{"summary":"지금 상태 한 줄","top3":[{"title":"고칠 점 (가장 점수를 많이 올리는 것부터)","why":"왜 먼저인가 한 줄","issue_ids":["관련 지적 id"]}],"qa":[{"q":"예상 질문","a":"준비할 답의 방향 한 줄"}]}
top3 는 최대 3개, qa 는 3~4개. 시점 간 판단이 크게 다르면 summary 에서 그 차이를 드러낸다.`,
};

// ── 응답 해석 ─────────────────────────────────
function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max = 8) => (Array.isArray(v) ? v : []).map((x) => str(x, 300)).filter(Boolean).slice(0, max);
const pick = (v, options, fallback) => options.find((o) => str(v) === o) || [...options].sort((a, b) => b.length - a.length).find((o) => str(v).includes(o)) || fallback;

function parseRead(text, slides = []) {
  const j = parseJson(text);
  if (!j) return { concept: '', context: '', target: '', slides: slides.map((s) => ({ n: s.n, role: '' })), facts: [], assumptions: [], raw: str(text, 4000) };
  const roles = new Map((Array.isArray(j.slides) ? j.slides : []).map((s) => [Number(s?.n), str(s?.role, 200)]));
  return {
    concept: str(j.concept), context: str(j.context), target: str(j.target),
    slides: slides.length ? slides.map((s) => ({ n: s.n, role: roles.get(s.n) || '' })) : [...roles].filter(([n]) => n > 0).map(([n, role]) => ({ n, role })).slice(0, 40),
    facts: list(j.facts), assumptions: list(j.assumptions),
  };
}

// 사용자가 고친 읽기 확인 내용을 정리한다.
function cleanRead(input, base) {
  const r = input && typeof input === 'object' ? input : {};
  const roles = new Map((Array.isArray(r.slides) ? r.slides : []).map((s) => [Number(s?.n), str(s?.role, 200)]));
  return {
    concept: str(r.concept) || base.concept, context: str(r.context) || base.context, target: str(r.target) || base.target,
    slides: base.slides.map((s) => ({ n: s.n, role: roles.has(s.n) ? roles.get(s.n) : s.role })),
    facts: Array.isArray(r.facts) ? list(r.facts, 12) : base.facts,
    assumptions: Array.isArray(r.assumptions) ? list(r.assumptions, 12) : base.assumptions,
  };
}
const linesOf = (text) => String(text || '').split('\n').map((l) => l.replace(/^\s*[-*·\d.)]+\s*/, '').trim()).filter(Boolean).slice(0, 12).map((l) => l.slice(0, 300));

function parseLens(text, lens, { scores: wantScores = true } = {}) {
  const j = parseJson(text);
  if (!j) return { scores: [], issues: [], questions: [], raw: str(text, 6000) };
  const scores = wantScores ? CRITERIA.map((c) => {
    const row = (Array.isArray(j.scores) ? j.scores : []).find((s) => str(s?.criterion).includes(c.label));
    const n = Math.round(Number(row?.score));
    return row && n >= 1 && n <= 5 ? { criterion: c.label, score: n, reason: str(row.reason, 200) } : null;
  }).filter(Boolean) : [];
  const issues = (Array.isArray(j.issues) ? j.issues : []).slice(0, 2).map((x, i) => {
    const fixes = (Array.isArray(x?.fixes) ? x.fixes : []).map((f) => ({ type: pick(f?.type, FIX_TYPES, '안전'), text: str(f?.text, 240) })).filter((f) => f.text).slice(0, 3);
    return {
      id: `${lens.id[0]}${i + 1}`, viewpoint: lens.label, lens: lens.id,
      criterion: pick(x?.criterion, CRITERION_LABELS, CRITERION_LABELS[0]),
      standard: str(x?.standard), gap: str(x?.gap), fixes,
      location: { slide: null, region: '', hint: str(x?.where, 120) },
      evidence_type: pick(x?.evidence_type, EVIDENCE, '추정'),
      severity: pick(x?.severity, SEVERITY, '중간'),
      user_verdict: '미판정', user_reason: '',
    };
  }).filter((x) => x.gap || x.standard);
  return { scores, issues, questions: list(j.questions, 3) };
}

function parseCheck(text) {
  const j = parseJson(text);
  return (Array.isArray(j?.checks) ? j.checks : []).slice(0, 12).map((c) => ({
    kind: pick(c?.kind, ['숫자', '일관성', '체크리스트'], '체크리스트'), item: str(c?.item, 200),
    result: pick(c?.result, ['확인 불가', '통과', '문제'], '확인 불가'), note: str(c?.note, 240),
    slide: Number.isInteger(c?.slide) ? c.slide : null,
  })).filter((c) => c.item);
}

const range = (v) => (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(Number(n)))
  ? [Math.max(0, Math.min(100, Number(v[0]))), Math.max(0, Math.min(100, Number(v[1])))].sort((a, b) => a - b) : null);
function parseLocate(text, slideCount) {
  const j = parseJson(text);
  const out = {};
  for (const l of Array.isArray(j?.locations) ? j.locations : []) {
    const id = str(l?.id, 8);
    if (!id) continue;
    const slide = Number.isInteger(l.slide) && l.slide >= 1 && (!slideCount || l.slide <= slideCount) ? l.slide : null;
    out[id] = { slide, region: pick(l.region, REGIONS, slide ? '전체' : ''), x: range(l.x), y: range(l.y), target: str(l.target, 80) };
  }
  return out;
}

function parseSynth(text) {
  const j = parseJson(text);
  if (!j) return { summary: '', top3: [], qa: [], raw: str(text, 6000) };
  return {
    summary: str(j.summary, 300),
    top3: (Array.isArray(j.top3) ? j.top3 : []).slice(0, 3).map((t) => ({ title: str(t?.title, 200), why: str(t?.why, 240), issue_ids: list(t?.issue_ids, 4) })).filter((t) => t.title),
    qa: (Array.isArray(j.qa) ? j.qa : []).slice(0, 5).map((x) => ({ q: str(x?.q, 240), a: str(x?.a, 300) })).filter((x) => x.q),
  };
}

// ── 점수 ──────────────────────────────────────
// 항목별로 시점 평균을 내고, 용도 비중으로 가중 평균한다.
function scoreTable(byLens, purpose) {
  const W = PURPOSES[purpose].weights;
  const rows = CRITERIA.map((c) => {
    const per = byLens.map((l) => l.scores.find((s) => s.criterion === c.label)?.score ?? null);
    const got = per.filter((n) => n !== null);
    return { criterion: c.label, weight: W[c.id], scores: per, avg: got.length ? Math.round((got.reduce((a, b) => a + b, 0) / got.length) * 10) / 10 : null };
  });
  const scored = rows.filter((r) => r.avg !== null);
  const wsum = scored.reduce((a, r) => a + r.weight, 0);
  const total = wsum ? Math.round((scored.reduce((a, r) => a + r.avg * r.weight, 0) / wsum) * 100) / 100 : null;
  return { rows, total, lenses: byLens.map((l) => l.label) };
}
const tableText = (t) => (t.total === null ? '' : `| 항목(비중) | ${t.lenses.join(' | ')} | 평균 |\n|---|${t.lenses.map(() => '---').join('|')}|---|\n${t.rows.map((r) => `| ${r.criterion}(${r.weight}%) | ${r.scores.map((s) => s ?? '-').join(' | ')} | ${r.avg ?? '-'} |`).join('\n')}\n가중 평균: ${t.total} / 5`);

// 코드로 판정할 수 있는 체크 (AI 에게 맡기지 않는다)
function autoChecks(purpose, slides) {
  if (purpose !== 'behance') return [];
  const out = [];
  const n = slides.length;
  out.push({ kind: '체크리스트', item: '이미지 3장 이상', result: n >= 3 ? '통과' : '문제', note: `${n}장${n < 3 ? ' · 3장 미만은 큐레이터에게 노출되지 않음' : n > 15 ? ' · 권장 5~15장보다 많음' : ''}`, slide: null, auto: true });
  const sized = slides.filter((s) => s.width);
  if (sized.length) {
    const off = sized.filter((s) => s.width !== 1400);
    out.push({ kind: '체크리스트', item: '이미지 폭 1400px', result: off.length ? '문제' : '통과', note: off.length ? `${off.map((s) => `${String(s.n).padStart(2, '0')}번 ${s.width}px`).slice(0, 5).join(', ')}` : '모두 1400px', slide: off[0]?.n ?? null, auto: true });
  }
  return out;
}

// 대화 기록·복사용 평문 (화면은 저장된 구조로 따로 그린다)
function reportText(C) {
  const P = PURPOSES[C.purpose];
  const loc = (x) => (x.location?.slide ? ` (${String(x.location.slide).padStart(2, '0')}번${x.location.region ? ` ${x.location.region}` : ''}${x.location.target ? ` · ${x.location.target}` : ''})` : '');
  const parts = [`# 크리틱 리포트 · ${P.label} · ${STAGES[C.stage].label} 단계`];
  if (C.synth?.summary) parts.push(C.synth.summary);
  const t = tableText(C.table || { total: null });
  if (t) parts.push(`## 점수\n${t}`);
  if (C.synth?.top3?.length) parts.push(`## 고칠 점 Top ${C.synth.top3.length}\n${C.synth.top3.map((x, i) => `${i + 1}. ${x.title}${x.why ? ` — ${x.why}` : ''}`).join('\n')}`);
  if (C.issues?.length) {
    parts.push(`## 지적\n${C.issues.map((x) => `### ${x.viewpoint} · ${x.criterion}${loc(x)} [${x.evidence_type} · ${x.severity}]\n- 기대 기준: ${x.standard}\n- 격차: ${x.gap}\n${x.fixes.map((f) => `- 개선 방향(${f.type}): ${f.text}`).join('\n')}`).join('\n')}`);
  }
  const bad = (C.checks || []).filter((c) => c.result !== '통과');
  if (C.checks?.length) parts.push(`## 검증\n${bad.length ? bad.map((c) => `- [${c.kind}] ${c.item}: ${c.result} — ${c.note}`).join('\n') : '- 확인한 항목에서 문제를 찾지 못했습니다.'}`);
  if (C.synth?.qa?.length) parts.push(`## 예상 질문과 답변 준비\n${C.synth.qa.map((x) => `- ${x.q} → ${x.a}`).join('\n')}`);
  for (const l of C.raw || []) parts.push(`## ${l.label} (형식을 읽지 못해 원문 그대로)\n${l.text}`);
  return parts.join('\n\n');
}

module.exports = {
  STEPS, STEP_LABEL, CRITERIA, PURPOSES, STAGES, FIX_TYPES, EVIDENCE, SEVERITY, VERDICTS, REGIONS, RUBRIC_BLOCK,
  parseOptions, prompts, parseRead, cleanRead, linesOf, parseLens, parseCheck, parseLocate, parseSynth,
  scoreTable, tableText, autoChecks, reportText,
};
