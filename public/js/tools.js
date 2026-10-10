'use strict';
// 페이지: 플러그인(외부 서비스 연결 · 추가 · AI별 허용) · 자동화(정해 둔 시간에 AI가 일하게 하기)
(() => {
  const { h, S, api, safe } = D;
  const head = D.pageHead;
  const section = D.pageSection;
  // 조건에 따라 빠지는 항목(null)은 건너뛰고 붙인다.
  const put = (body, ...kids) => body.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const pretty = (name) => name.replace(/^claude\.ai /, '').replace(/^plugin:([^:]+):.*/, '$1').replace(/_/g, ' ');

  // ── 플러그인 ─────────────────────────────────
  const STATUS = { connected: ['연결됨', 'pass'], 'needs-auth': ['로그인 필요', 'revise'], failed: ['연결 실패', 'revise'], unknown: ['추가됨', ''] };
  const SOURCE = { 'claude.ai': 'Claude 계정에 연결됨', plugin: 'Claude 플러그인', claude: 'Claude Code에 등록됨', domo: 'DOMO에서 추가', custom: 'DOMO에서 추가' };
  const removable = (p) => p.source === 'domo' || p.source === 'custom';
  let pluginTimer = null;

  async function loadPlugins(refresh) {
    const r = await safe(api('GET', `/api/plugins${refresh ? '?refresh' : ''}`));
    if (!r) return;
    S.plugins = r.plugins;
    S.pluginCatalog = r.catalog;
    S.pluginSetup = r.canSetup;
    D.rerenderPage(['plugins']);
    // 로그인 중인 플러그인이 있으면 끝날 때까지 상태를 다시 읽는다.
    clearTimeout(pluginTimer);
    if (r.plugins.some((p) => p.loggingIn) && S.view === 'plugins') pluginTimer = setTimeout(() => loadPlugins(), 2000);
    else if (S.pluginWasLoggingIn) { S.pluginWasLoggingIn = false; return loadPlugins(true); }
    S.pluginWasLoggingIn = r.plugins.some((p) => p.loggingIn);
  }

  async function loginPlugin(p) {
    const r = await safe(api('POST', `/api/plugins/${encodeURIComponent(p.name)}/login`));
    if (!r) return;
    D.toast('브라우저에 열린 창에서 로그인해 주세요');
    S.plugins = r.plugins;
    S.pluginWasLoggingIn = true;
    D.rerenderPage(['plugins']);
    clearTimeout(pluginTimer);
    pluginTimer = setTimeout(() => loadPlugins(), 2000);
  }

  function renderPlugins() {
    if (!S.plugins) loadPlugins();
    const list = S.plugins || [];
    const users = (p) => D.agents().filter((a) => (a.plugins || []).includes(p.name));
    const row = (p) => {
      const [label, cls] = p.loggingIn ? ['로그인 기다리는 중', 'revise'] : STATUS[p.status] || STATUS.unknown;
      const n = users(p).length;
      return h('button', { class: 'list-row', type: 'button', onclick: () => pluginSheet(p) },
        h('span', { class: 'grow row-text' }, h('b', { class: 'row-title' }, pretty(p.name)),
          h('span', { class: 'row-sub' }, `${SOURCE[p.source] || ''} · ${n ? `AI ${n}명이 사용` : '사용하는 AI 없음'}`)),
        h('span', { class: `tag ${cls}` }, label));
    };
    return [
      head('플러그인', 'AI가 노션·피그마 같은 서비스를 직접 읽고 쓰게 연결합니다. 어떤 AI가 쓸지도 여기서 정해요.',
        h('button', { class: 'btn-primary small', type: 'button', onclick: addPluginSheet }, D.icon.plus(16), '플러그인 추가')),
      !S.plugins ? h('p', { class: 'page-note' }, '연결 상태를 확인하는 중이에요. 몇 초 걸려요…')
        : list.length ? h('div', { class: 'list' }, list.map(row))
          : h('div', { class: 'empty-state' }, '아직 연결된 플러그인이 없어요. "플러그인 추가"에서 골라 보세요.'),
      S.plugins ? h('div', { class: 'page-gap' }, h('button', { class: 'btn-ghost small', type: 'button', onclick: () => { S.plugins = null; D.renderPage('plugins'); loadPlugins(true); } }, '상태 다시 확인')) : null,
      section('Gmail·캘린더·드라이브는', 'Claude 계정의 커넥터로 연결하면 여기에 자동으로 나타납니다.',
        h('a', { class: 'btn-ghost small', href: 'https://claude.ai/settings/connectors', target: '_blank', rel: 'noopener noreferrer' }, 'Claude 커넥터 설정 열기')),
    ];
  }

  function pluginSheet(p) {
    const [label] = STATUS[p.status] || STATUS.unknown;
    let allowed = D.agents().filter((a) => (a.plugins || []).includes(p.name)).map((a) => a.id);
    D.openSheet({ title: pretty(p.name), done: '저장', onDone: async () => {
      if (!(await safe(api('PUT', `/api/plugins/${encodeURIComponent(p.name)}/agents`, { agents: allowed })))) return false;
      await D.loadMe();
      D.rerenderPage(['plugins']);
      return true;
    } }, (body) => put(body,
      h('p', { class: 'sheet-note' }, `${label}${p.statusText ? ` · ${p.statusText}` : ''}${p.target ? ` · ${p.target}` : ''}`),
      p.status === 'needs-auth' && !p.loggingIn
        ? (S.pluginSetup && p.source !== 'claude.ai'
          ? h('button', { class: 'btn-primary small', type: 'button', onclick: () => { D.closeSheet(); loginPlugin(p); } }, '브라우저에서 로그인')
          : h('p', { class: 'sheet-note' }, p.source === 'claude.ai' ? 'Claude 커넥터 설정에서 다시 연결해 주세요.' : 'DOMO가 설치된 컴퓨터에서 로그인해 주세요.'))
        : null,
      h('div', { class: 'sheet-label' }, '이 플러그인을 쓸 AI'),
      D.chips(D.agents().map((a) => [a.id, a.name]), allowed, { multi: true, onChange: (v) => { allowed = v; } }),
      h('p', { class: 'sheet-note' }, '선택한 AI만 대화 중에 이 플러그인을 쓸 수 있어요. 모두 끄면 플러그인은 남아 있지만 쓰이지 않습니다.'),
      removable(p) ? h('div', { class: 'sheet-actions' }, h('button', { class: 'btn-ghost small danger', type: 'button', onclick: D.confirmTwice('플러그인 삭제', async () => {
        const r = await safe(api('DELETE', `/api/plugins/${encodeURIComponent(p.name)}`));
        if (!r) return;
        S.plugins = r.plugins;
        await D.loadMe();
        D.closeSheet();
        D.rerenderPage(['plugins']);
      }) }, '플러그인 삭제')) : null));
  }

  async function addPlugin(payload, needsLogin) {
    D.toast('추가하는 중…');
    const r = await safe(api('POST', '/api/plugins', payload));
    if (!r) return false;
    S.plugins = r.plugins;
    await D.loadMe();
    D.closeSheet();
    D.rerenderPage(['plugins']);
    const p = r.plugins.find((x) => x.name === r.name);
    if (needsLogin && p?.status === 'needs-auth' && S.pluginSetup) loginPlugin(p);
    else D.toast(`${pretty(r.name)} 플러그인을 추가했어요`);
    return true;
  }

  function addPluginSheet() {
    const have = new Set((S.plugins || []).map((p) => pretty(p.name).toLowerCase()));
    D.openSheet({ title: '플러그인 추가' }, (body) => body.append(
      h('p', { class: 'sheet-note' }, '누르면 추가되고, 브라우저에서 해당 서비스에 로그인하면 연결됩니다.'),
      h('div', { class: 'menu-list' },
        (S.pluginCatalog || []).map((c) => (have.has(c.name.toLowerCase())
          ? h('div', { class: 'menu-item off' }, h('b', {}, c.name), h('span', {}, '이미 연결되어 있어요'))
          : h('button', { class: 'menu-item', type: 'button', onclick: () => addPlugin({ preset: c.id }, !c.noLogin) }, h('b', {}, c.name), h('span', {}, c.desc)))),
        h('button', { class: 'menu-item', type: 'button', onclick: () => { D.closeSheet(); customPluginSheet(); } }, h('b', {}, '직접 추가'), h('span', {}, 'MCP 서버 주소를 알고 있을 때')))));
  }

  function customPluginSheet() {
    const v = { name: '', url: '', token: '', mode: 'oauth' };
    const text = (key, attrs) => h('input', { class: 'auth-input', type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs, oninput: (e) => { v[key] = e.target.value.trim(); } });
    const tokenRow = D.field('토큰', text('token', { placeholder: '서비스에서 발급받은 API 토큰' }));
    tokenRow.hidden = true;
    D.openSheet({ title: '플러그인 직접 추가', done: '추가', onDone: () => addPlugin(
      v.mode === 'oauth' ? { name: v.name, url: v.url, oauth: true } : { name: v.name, url: v.url, token: v.mode === 'token' ? v.token : '' }, v.mode === 'oauth') }, (body) => body.append(
      D.field('이름', text('name', { placeholder: '예) my-notes (영문·숫자)' })),
      D.field('MCP 서버 주소', text('url', { placeholder: 'https://…/mcp', inputmode: 'url' })),
      h('div', { class: 'sheet-label' }, '연결 방식'),
      D.segmented([['oauth', '브라우저 로그인'], ['token', '토큰'], ['none', '필요 없음']], v.mode, (m) => { v.mode = m; tokenRow.hidden = m !== 'token'; }),
      tokenRow,
      h('p', { class: 'sheet-note' }, '토큰은 이 컴퓨터의 DOMO 설정 파일에만 저장됩니다. 믿을 수 있는 서비스의 주소만 추가하세요. 플러그인은 AI가 대화 내용을 그 서비스로 보낼 수 있게 합니다.')));
  }

  // ── 자동화 ───────────────────────────────────
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const TEMPLATES = [
    { name: '아침 브리핑', time: '08:30', days: [1, 2, 3, 4, 5], prompt: '마감이 가까운 과제와 진행 중인 프로젝트를 정리하고, 오늘 먼저 할 일 세 가지를 제안해줘.', blurb: '평일 아침, 오늘 할 일 세 가지' },
    { name: '마감 알림', time: '21:00', days: [0, 1, 2, 3, 4, 5, 6], prompt: '3일 안에 마감인 과제가 있으면 남은 일과 순서를 알려줘. 없으면 "임박한 마감 없음"이라고만 답해줘.', blurb: '매일 저녁, 임박한 마감 확인' },
    { name: '주간 회고', time: '18:00', days: [5], prompt: '이번 주에 나눈 대화와 내린 결정, 끝낸 과제를 요약하고 다음 주에 이어갈 일을 정리해줘.', blurb: '금요일 저녁, 한 주 정리' },
    { name: '레퍼런스 스크랩', time: '09:00', days: [1, 4], prompt: '/리서치 내 전공·관심 분야의 이번 주 새 디자인 레퍼런스와 공모전 소식', blurb: '월·목 아침, 팀이 리서치' },
  ];
  const dayText = (days) => (days.length === 7 ? '매일' : days.join() === '1,2,3,4,5' ? '평일' : days.join() === '0,6' ? '주말' : days.map((d) => DAYS[d]).join('·'));

  async function loadSchedules() {
    const r = await safe(api('GET', '/api/schedules'));
    if (!r) return;
    S.schedules = r.schedules;
    S.schedulesLoaded = true;
    D.rerenderPage(['automations']);
  }
  D.loadSchedules = loadSchedules;

  function renderAutomations() {
    if (!S.schedulesLoaded) loadSchedules();
    const where = (s) => (s.target === 'new' ? `${D.agent(s.agentId)?.name || '기본 AI'} · 매번 새 채팅` : S.rooms.find((r) => r.id === s.roomId)?.name || '대화가 삭제됨');
    const row = (s) => h('div', { class: 'list-row' },
      h('button', { class: 'row-main grow', type: 'button', onclick: () => scheduleSheet(s) },
        h('b', { class: 'row-title' }, s.name),
        h('span', { class: 'row-sub' }, `${dayText(s.days)} ${s.time} · ${where(s)}`),
        s.runs?.[0] ? h('span', { class: 'row-sub' }, `마지막 실행 ${D.fmtShort(s.runs[0].ts)}`) : null),
      D.toggle(s.enabled, async (on) => { await safe(api('PATCH', `/api/schedules/${s.id}`, { enabled: on })); loadSchedules(); }));
    return [
      head('자동화', '정해 둔 시간에 AI가 알아서 일하고 결과를 대화로 남깁니다. DOMO가 켜져 있을 때 실행돼요.',
        h('button', { class: 'btn-primary small', type: 'button', onclick: () => scheduleSheet(null) }, D.icon.plus(16), '새 자동화')),
      !S.schedulesLoaded ? h('p', { class: 'page-note' }, '불러오는 중…')
        : S.schedules.length ? h('div', { class: 'list' }, S.schedules.map(row)) : null,
      section(S.schedules.length ? '이런 자동화도 있어요' : '바로 시작하기', '고른 뒤 시간과 내용을 바꿀 수 있어요.',
        h('div', { class: 'menu-list' }, TEMPLATES.map((t) => h('button', { class: 'menu-item', type: 'button', onclick: () => scheduleSheet(null, t) }, h('b', {}, t.name), h('span', {}, t.blurb))))),
    ];
  }

  function scheduleSheet(exist, template) {
    const v = exist
      ? { name: exist.name, prompt: exist.prompt, time: exist.time, days: [...exist.days], target: exist.target || 'room', agentId: exist.agentId || D.primaryId(), roomId: exist.roomId }
      : { name: template?.name || '', prompt: template?.prompt || '', time: template?.time || '09:00', days: template?.days || [1, 2, 3, 4, 5], target: 'new', agentId: D.primaryId(), roomId: S.rooms[0]?.id || '' };
    const save = async () => {
      if (!v.prompt.trim()) { D.toast('AI에게 시킬 일을 적어 주세요'); return false; }
      if (v.target === 'room' && !v.roomId) { D.toast('이어서 보낼 대화를 골라 주세요'); return false; }
      const body = { ...v, name: v.name.trim() || v.prompt.trim().slice(0, 20) };
      const r = await safe(exist ? api('PATCH', `/api/schedules/${exist.id}`, body) : api('POST', '/api/schedules', body));
      if (!r) return false;
      await loadSchedules();
      return true;
    };
    D.openSheet({ title: exist ? '자동화 편집' : '새 자동화', done: '저장', onDone: save, wide: true }, (body) => {
      const agentBox = h('div', {}, h('div', { class: 'sheet-label' }, '담당 AI'), D.chips(D.agents().map((a) => [a.id, a.name]), v.agentId, { onChange: (id) => { v.agentId = id; } }));
      const roomBox = h('div', {}, h('div', { class: 'sheet-label' }, '이어서 보낼 대화'),
        S.rooms.length
          ? h('select', { class: 'auth-input', 'aria-label': '대화 선택', onchange: (e) => { v.roomId = e.target.value; } }, S.rooms.map((r) => h('option', { value: r.id, selected: r.id === v.roomId }, r.name)))
          : h('p', { class: 'sheet-note' }, '아직 대화가 없어요. "매번 새 채팅"을 쓰세요.'));
      const sync = () => { agentBox.hidden = v.target !== 'new'; roomBox.hidden = v.target === 'new'; };
      sync();
      put(body,
        D.field('이름', h('input', { class: 'auth-input', type: 'text', maxlength: 40, value: v.name, placeholder: '예) 아침 브리핑', oninput: (e) => { v.name = e.target.value; } })),
        D.field('AI에게 시킬 일', h('textarea', { class: 'auth-input area', rows: 4, maxlength: 4000, placeholder: '예) 오늘 마감인 과제를 정리해줘. /리서치 처럼 팀 서비스 명령으로 시작해도 돼요.', oninput: (e) => { v.prompt = e.target.value; } }, v.prompt)),
        h('div', { class: 'form-grid' },
          D.field('시각', h('input', { class: 'auth-input', type: 'time', value: v.time, onchange: (e) => { if (e.target.value) v.time = e.target.value; } })),
          h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, '요일'),
            D.chips(DAYS.map((d, i) => [i, d]), v.days, { multi: true, onChange: (d) => { v.days = d.length ? d : [0, 1, 2, 3, 4, 5, 6]; } }))),
        h('div', { class: 'sheet-label' }, '결과를 남길 곳'),
        D.segmented([['new', '매번 새 채팅'], ['room', '같은 대화에 이어서']], v.target, (t) => { v.target = t; sync(); }),
        agentBox, roomBox,
        exist?.runs?.length ? h('div', {}, h('div', { class: 'sheet-label' }, '최근 실행'),
          h('div', { class: 'list' }, exist.runs.slice(0, 5).map((r) => (S.rooms.some((x) => x.id === r.roomId)
            ? h('a', { class: 'list-row', href: `#/c/${encodeURIComponent(r.roomId)}`, onclick: () => D.closeSheet() }, h('span', { class: 'grow' }, D.fmtShort(r.ts)), h('span', { class: 'row-sub' }, '결과 보기'))
            : h('div', { class: 'list-row' }, h('span', { class: 'grow' }, D.fmtShort(r.ts)), h('span', { class: 'row-sub' }, '대화가 삭제됨')))))) : null,
        exist ? h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn-ghost small', type: 'button', onclick: async () => { if (await save()) { const r = await safe(api('POST', `/api/schedules/${exist.id}/run`)); if (r) { D.closeSheet(); D.toast('실행했어요. 결과는 대화에 남습니다.'); await D.loadRooms(); loadSchedules(); } } } }, '지금 실행'),
          h('button', { class: 'btn-ghost small danger', type: 'button', onclick: D.confirmTwice('삭제', async () => { if (await safe(api('DELETE', `/api/schedules/${exist.id}`))) { D.closeSheet(); loadSchedules(); } }) }, '삭제')) : null);
    });
  }

  D.PAGES.plugins = renderPlugins;
  D.PAGES.automations = renderAutomations;
})();
