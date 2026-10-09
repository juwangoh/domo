'use strict';
// 첫 화면: 회원가입(이 DOMO의 주인 계정) · 로그인 · 온보딩(AI 연결 → 나에 대한 질문 → 맞춤 팀 + 첫 작업 추천)
(() => {
  const { h, $, S, api, safe } = D;

  // ── 회원가입 · 로그인 ────────────────────────
  D.showAuth = async () => {
    S.es?.close();
    $('app').hidden = true;
    $('onboarding').hidden = true;
    const root = $('auth');
    root.hidden = false;
    let setup = { hasAccount: true };
    try { setup = await api('GET', '/api/setup'); } catch { /* 서버 오류면 로그인 화면 */ }
    renderAuth(root, setup, setup.hasAccount ? 'login' : 'signup');
  };

  function renderAuth(root, setup, mode) {
    const err = h('p', { class: 'auth-error', role: 'alert' });
    const v = { name: '', email: '', password: '', setupCode: '' };
    const input = (key, attrs) => h('input', { class: 'auth-input', ...attrs, oninput: (e) => { v[key] = e.target.value; } });
    const submit = h('button', { class: 'btn-primary wide', type: 'submit' }, mode === 'signup' ? '계정 만들기' : '로그인');
    const form = h('form', { class: 'auth-form', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        if (mode === 'signup') await api('POST', '/api/signup', v);
        else await api('POST', '/api/login', { email: v.email, password: v.password });
        root.hidden = true;
        D.boot();
      } catch (ex) { err.textContent = ex.message; }
      submit.disabled = false;
    } },
      mode === 'signup' ? D.field('이름', input('name', { type: 'text', autocomplete: 'name', placeholder: '홍길동', required: true })) : null,
      D.field('이메일', input('email', { type: 'email', autocomplete: 'email', placeholder: 'name@example.com', required: mode === 'signup' })),
      D.field('비밀번호', input('password', { type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', placeholder: mode === 'signup' ? '8자 이상' : '', required: true, minlength: mode === 'signup' ? 8 : null })),
      mode === 'signup' && setup.needsCode ? D.field('설정 코드', input('setupCode', { type: 'text', inputmode: 'numeric', placeholder: '서버 터미널에 표시된 6자리', required: true })) : null,
      submit, err);

    root.replaceChildren(h('div', { class: 'auth-card' },
      h('img', { src: '/mark-ink.svg', alt: '', class: 'auth-mark', width: 56, height: 56 }),
      h('h1', { class: `auth-title${mode === 'signup' ? '' : ' brand-title'}` }, mode === 'signup' ? '내 DOMO 만들기' : 'DOMO'),
      h('p', { class: 'auth-sub' }, mode === 'signup'
        ? '디자인 전공생을 위한 AI 스튜디오. 이 컴퓨터에서만 쓰는 내 계정을 만듭니다.'
        : setup.tagline || '디자인 전공생을 위한 AI 스튜디오'),
      form,
      mode === 'signup'
        ? h('p', { class: 'auth-foot' }, 'AI는 이 컴퓨터에 로그인한 내 Claude·Codex 구독으로 동작합니다. DOMO는 AI 계정 정보를 보관하지 않습니다.')
        : null));
  }

  // ── 온보딩 ───────────────────────────────────
  // ① AI 연결 확인 → ② 나에 대한 질문 → ③ 맞춤 팀 + 첫 작업 추천
  D.showOnboarding = (step = 'connect') => {
    $('app').hidden = true;
    const root = $('onboarding');
    root.hidden = false;
    const steps = { connect: stepConnect, about: stepAbout };
    steps[step](root);
  };

  function frame(root, n, title, sub, ...body) {
    root.replaceChildren(h('div', { class: 'onb-card' },
      h('div', { class: 'onb-steps' }, [1, 2, 3].map((i) => h('span', { class: i <= n ? 'on' : '' }))),
      h('h1', { class: 'onb-title' }, title),
      sub ? h('p', { class: 'onb-sub' }, sub) : null,
      ...body));
  }

  async function stepConnect(root) {
    frame(root, 1, 'AI를 연결할게요', '이 컴퓨터의 Claude와 Codex에 본인 계정으로 로그인되어 있는지 확인합니다.', h('div', { class: 'conn-list' }, h('div', { class: 'muted' }, '확인하는 중…')));
    const c = (await safe(api('GET', '/api/connections?refresh'))).connections;
    S.connections = c;
    const ok = c.claude.loggedIn || c.codex.loggedIn;
    frame(root, 1, 'AI를 연결할게요', '이 컴퓨터의 Claude와 Codex에 본인 계정으로 로그인되어 있는지 확인합니다.',
      D.connectionCards(c),
      h('div', { class: 'onb-actions' },
        h('button', { class: 'btn-ghost', type: 'button', onclick: () => stepConnect(root) }, '다시 확인'),
        h('button', { class: 'btn-primary', type: 'button', onclick: () => stepAbout(root) }, ok ? '다음' : '나중에 연결하고 다음')),
      !ok ? h('p', { class: 'onb-note' }, 'AI 연결 없이도 다음 단계는 진행할 수 있어요. 대화는 연결한 뒤에 시작됩니다.') : null);
  }

  // 연결 카드: 로그인 상태와, 안 됐으면 터미널에서 할 일을 보여준다 (설정 화면에서도 같이 쓴다).
  D.connectionCards = (c) => {
    const card = (key, title, st, cmd, plan) => h('div', { class: `conn-card${st.loggedIn ? ' ok' : ''}` },
      h('div', { class: 'conn-top' },
        h('span', { class: `conn-dot${st.loggedIn ? ' ok' : ''}` }),
        h('b', {}, title),
        h('span', { class: 'conn-state' }, st.loggedIn ? `연결됨${plan ? ` · ${plan}` : ''}` : st.installed ? '로그인 필요' : '설치 필요')),
      st.loggedIn ? null : h('div', { class: 'conn-how' },
        h('div', {}, st.installed ? `${c.codespace ? 'Codespace' : '이 컴퓨터'}의 터미널에서 아래 명령을 실행하고, 브라우저에서 본인 계정으로 로그인하세요.` : '먼저 설치가 필요합니다.'),
        h('button', { class: 'cmd', type: 'button', title: '눌러서 복사', onclick: () => D.copy(cmd) }, h('code', {}, cmd), D.icon.copy(16))));
    return h('div', { class: 'conn-list' },
      card('claude', 'Claude Code', c.claude, c.claude.installed ? 'claude auth login' : 'npm install -g @anthropic-ai/claude-code', c.claude.plan ? `${c.claude.plan.toUpperCase()} 구독` : c.claude.method === 'console' ? 'API' : ''),
      card('codex', 'Codex', c.codex, c.codex.installed ? 'codex login' : 'npm install -g @openai/codex', c.codex.method === 'chatgpt' ? 'ChatGPT 구독' : ''));
  };

  function stepAbout(root) {
    const T = S.me.team;
    const a = { job: '', field: '', work: '', interests: '', hobbies: '', tasks: [], tone: 'direct', goal: '' };
    const text = (key, placeholder, max = 120) => h('input', { class: 'auth-input', type: 'text', maxlength: max, placeholder, oninput: (e) => { a[key] = e.target.value; } });
    const area = (key, placeholder) => h('textarea', { class: 'auth-input area', rows: 2, placeholder, oninput: (e) => { a[key] = e.target.value; } });
    const go = h('button', { class: 'btn-primary', type: 'button', onclick: async () => {
      go.disabled = true;
      go.textContent = '팀을 꾸리는 중…';
      const r = await safe(api('POST', '/api/onboarding', { answers: a }));
      go.disabled = false;
      go.textContent = '내 팀 만들기';
      if (r) stepDone(root, r);
    } }, '내 팀 만들기');
    frame(root, 2, `${S.me.user.name}님에 대해 알려 주세요`, '답에 맞춰 AI 팀의 페르소나를 만들고, 바로 시작할 작업을 추천해 드려요. 나중에 언제든 바꿀 수 있어요.',
      h('div', { class: 'onb-grid' },
        D.field('직업', text('job', '예) 대학생, 주니어 디자이너')),
        D.field('전공·분야', text('field', '예) 산업디자인 3학년')),
        D.field('요즘 하는 일', area('work', '예) 졸업전시 준비, 공모전 출품작 작업')),
        D.field('관심사', area('interests', '예) 가구, 지속가능 소재, 일본 브랜드')),
        D.field('취미', text('hobbies', '예) 빈티지 수집, 사진')),
        D.field('지금 목표', text('goal', '예) 11월 졸업전시 마무리', 200))),
      h('div', { class: 'onb-label' }, 'DOMO와 자주 할 작업 (여러 개)'),
      D.chips(T.taskOptions.map((o) => [o.id, o.label]), [], { multi: true, onChange: (v) => { a.tasks = v; } }),
      h('div', { class: 'onb-label' }, '어떤 톤의 피드백이 좋나요?'),
      D.chips(Object.entries(T.tones).map(([k, t]) => [k, t.label]), 'direct', { onChange: (v) => { a.tone = v; } }),
      h('div', { class: 'onb-actions' },
        h('button', { class: 'btn-ghost', type: 'button', onclick: () => stepConnect(root) }, '이전'), go));
  }

  function stepDone(root, r) {
    const team = r.agents.filter((x) => x.studioRole);
    const roles = S.me.options.studioRoles;
    frame(root, 3, '팀이 준비됐어요', '평소에는 한 명이 빠르게 답하고, 크리틱·컨셉·리서치·검증이 필요할 때만 팀이 함께 일합니다.',
      h('div', { class: 'team-strip' }, team.map((x) => h('div', { class: 'team-chip' }, D.avatarEl(x, 'sm'), h('div', {}, h('b', {}, x.name), h('span', {}, roles[x.studioRole]?.label || ''))))),
      h('div', { class: 'onb-label' }, '이런 작업부터 해볼까요?'),
      h('div', { class: 'suggest-list' }, r.suggestions.map((s) => h('button', { class: 'suggest-card', type: 'button', onclick: () => finish(s) },
        h('b', {}, s.title), h('span', {}, s.prompt.replace(/^\/\S+\s*/, '').slice(0, 70))))),
      h('div', { class: 'onb-actions' }, h('button', { class: 'btn-ghost', type: 'button', onclick: () => finish(null) }, '그냥 둘러볼게요')));
  }

  async function finish(suggestion) {
    $('onboarding').hidden = true;
    await D.boot({ skipOnboarding: true });
    if (suggestion) D.startWithPrompt(suggestion.prompt);
  }
})();
