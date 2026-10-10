'use strict';
// 앱 뼈대 (Claude 앱 구조): 왼쪽 사이드바(새 채팅 · 메뉴 · 최근 대화 · 내 계정) + 가운데 본문.
// 주소: #/  (새 채팅) · #/c/<방> · #/team · #/memory · #/insights · #/settings
(() => {
  const { h, $, S, api, safe } = D;

  D.loadMe = async () => { S.me = await api('GET', '/api/me'); };
  D.loadRooms = async () => {
    S.rooms = (await api('GET', '/api/rooms')).rooms;
    D.renderSidebar();
    if (S.roomId && !S.rooms.some((r) => r.id === S.roomId) && S.view === 'chat') location.hash = '#/';
    else if (S.view === 'chat') { D.renderChatHeader(); D.renderTopbar(); }
  };
  D.loadMemory = async () => { S.memory = (await api('GET', '/api/memory')).memory; };

  D.boot = async ({ skipOnboarding = false } = {}) => {
    try { await D.loadMe(); } catch { return; }
    $('auth').hidden = true;
    // 처음 쓰는 사람(아직 팀이 없는 새 DOMO)은 온보딩부터.
    if (!skipOnboarding && !S.me.settings.onboarded && !D.agents().some((a) => a.studioRole)) {
      D.showOnboarding('connect');
      return;
    }
    $('onboarding').hidden = true;
    $('app').hidden = false;
    await Promise.all([D.loadRooms(), safe(D.loadMemory())]);
    connectEvents();
    route();
    D.refreshConnections();
  };

  // AI 연결 상태 (끊겨 있으면 상단에 알림 띠)
  D.refreshConnections = async (refresh) => {
    const r = await safe(api('GET', `/api/connections${refresh ? '?refresh' : ''}`));
    if (!r) return;
    S.connections = r.connections;
    D.rerenderPage?.(['settings']);
    const c = r.connections;
    const banner = $('connBanner');
    const missing = !c.claude.loggedIn && !c.codex.loggedIn;
    banner.hidden = !missing;
    if (missing) banner.replaceChildren(h('span', {}, 'AI가 연결되어 있지 않아요. 대화하려면 Claude나 Codex에 로그인하세요.'), h('button', { class: 'link-btn strong', onclick: () => { location.hash = '#/settings'; } }, 'AI 연결'));
  };

  // ── 실시간 이벤트 ────────────────────────────
  function connectEvents() {
    S.es?.close();
    const es = new EventSource('/api/events');
    S.es = es;
    let hadError = false;
    es.onopen = () => { if (hadError) { D.loadRooms(); if (S.view === 'chat') D.openRoom(S.roomId, { keepScroll: true }); } hadError = false; };
    es.onerror = () => {
      hadError = true;
      if (es.readyState === EventSource.CLOSED) setTimeout(() => api('GET', '/api/me').then(connectEvents).catch(() => {}), 3000);
    };
    const on = (ev, fn) => es.addEventListener(ev, (e) => fn(JSON.parse(e.data)));
    on('message', (m) => D.onMessage(m));
    on('update', (m) => D.onUpdate(m));
    on('typing', ({ roomId, agentId, on: isOn }) => {
      const set = (S.typing[roomId] ||= new Set());
      isOn ? set.add(agentId) : set.delete(agentId);
      if (!isOn && S.activity[roomId]) delete S.activity[roomId][agentId];
      if (roomId === S.roomId) { D.renderTyping(); D.renderChatHeader(); }
      D.renderSidebar();
    });
    on('activity', ({ roomId, agentId, label, text }) => {
      (S.activity[roomId] ||= {})[agentId] = { label, text };
      if (roomId === S.roomId) D.renderTyping();
    });
    on('status', ({ roomId, running }) => {
      const room = S.rooms.find((r) => r.id === roomId);
      if (room) room.running = running;
      if (!running) { S.typing[roomId]?.clear(); if (S.activity[roomId]) S.activity[roomId] = {}; }
      if (roomId === S.roomId) { D.renderChatHeader(); D.renderTyping(); D.syncComposer(); }
      D.renderSidebar();
    });
    on('rooms', () => D.loadRooms());
    on('agents', async () => { await D.loadMe(); D.renderSidebar(); if (S.view === 'chat') { D.renderChatHeader(); D.renderMessages(); } D.rerenderPage(['team', 'settings', 'plugins']); });
    on('memory', async () => { await D.loadMemory(); D.rerenderPage(['memory']); if (S.view === 'chat') D.renderMessages(); });
    on('schedules', () => { if (S.view === 'automations') D.loadSchedules(); });
    on('skills', () => { S.skills = null; D.rerenderPage(['memory']); });
    on('tunnel', (t) => { S.me.tunnel = t; D.rerenderPage(['settings']); });
  }

  // ── 라우팅 ───────────────────────────────────
  function route() {
    const hash = location.hash || '#/';
    const m = hash.match(/^#\/c\/(.+)$/);
    D.closeDrawer();
    if (m && S.rooms.some((r) => r.id === decodeURIComponent(m[1]))) return show('chat', decodeURIComponent(m[1]));
    const page = hash.match(/^#\/(team|memory|insights|settings|plugins|automations)$/)?.[1];
    if (page) return show(page);
    return show('home');
  }
  window.addEventListener('hashchange', route);
  D.go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

  function show(view, roomId) {
    S.view = view;
    $('main').dataset.view = view;
    for (const v of ['home', 'chat', 'page']) $(`view-${v}`).hidden = !(v === view || (v === 'page' && !['home', 'chat'].includes(view)));
    if (view === 'chat') D.openRoom(roomId);
    else {
      S.roomId = null;
      if (view === 'home') D.renderHome();
      else D.renderPage(view);
    }
    D.renderSidebar();
    D.renderTopbar();
  }

  // ── 사이드바 ─────────────────────────────────
  D.renderSidebar = () => {
    if (!S.me) return;
    const nav = (hash, label, ic, view) => h('a', { class: `nav-item${S.view === view ? ' on' : ''}`, href: hash }, ic(18), h('span', {}, label));
    const openTasks = (S.memory?.tasks || []).filter((t) => t.status !== 'done').length;
    // 대화 목록: 검색어가 있으면 이름으로 거른다. 검색 중에는 목록만 다시 그려서 입력칸의 포커스를 지킨다.
    const listBox = h('div', { class: 'side-list' });
    const drawList = () => {
      const q = (S.roomQuery || '').trim().toLowerCase();
      const rooms = q ? S.rooms.filter((r) => r.name.toLowerCase().includes(q)) : S.rooms;
      const groups = new Map();
      for (const r of rooms) {
        const g = D.dayGroup(r.last?.ts || r.createdAt);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r);
      }
      const list = [...groups.entries()].map(([g, rs]) => [
        h('div', { class: 'side-label' }, g),
        rs.map((r) => {
          const live = r.running || S.typing[r.id]?.size;
          const waiting = r.project?.awaiting && !r.running;
          return h('a', { class: `room-item${r.id === S.roomId ? ' on' : ''}`, href: `#/c/${encodeURIComponent(r.id)}`, title: r.name },
            h('span', { class: 'room-name' }, r.name),
            live ? h('span', { class: 'dot live', title: '진행 중' }) : waiting ? h('span', { class: 'dot wait', title: '내 차례' }) : S.unread[r.id] ? h('span', { class: 'dot', title: '새 메시지' }) : null);
        }),
      ]);
      listBox.replaceChildren(...(rooms.length ? list : [h('div', { class: 'side-empty' }, q ? '찾는 대화가 없어요' : '아직 대화가 없어요')]).flat(Infinity));
    };
    drawList();
    const search = h('label', { class: 'side-search' }, D.icon.search(18),
      h('input', { type: 'search', placeholder: '대화 검색', 'aria-label': '대화 검색', value: S.roomQuery || '', enterkeyhint: 'search', oninput: (e) => { S.roomQuery = e.target.value; drawList(); } }));
    // 검색 중에 다른 이유로 사이드바를 다시 그릴 때는 목록만 바꾼다.
    const old = $('sidebar').querySelector('.side-search input');
    if (old && document.activeElement === old) {
      $('sidebar').querySelector('.side-list').replaceWith(listBox);
      return;
    }
    $('sidebar').replaceChildren(
      h('div', { class: 'side-top' },
        h('a', { class: 'brand', href: '#/' }, h('img', { src: '/mark-ink.svg', alt: '', width: 24, height: 24 }), h('span', {}, 'DOMO')),
        h('button', { class: 'icon-btn only-mobile', type: 'button', 'aria-label': '메뉴 닫기', onclick: D.closeDrawer }, '✕')),
      h('button', { class: 'new-chat', type: 'button', onclick: () => D.go('#/') }, D.icon.plus(18), h('span', {}, '새 채팅')),
      search,
      h('nav', { class: 'side-nav' },
        nav('#/memory', `과제·기억${openTasks ? ` · ${openTasks}` : ''}`, D.icon.memory, 'memory'),
        nav('#/automations', '자동화', D.icon.clock, 'automations'),
        nav('#/plugins', '플러그인', D.icon.plug, 'plugins'),
        nav('#/team', 'AI 팀', D.icon.team, 'team'),
        nav('#/insights', '1명 vs 팀 인사이트', D.icon.chart, 'insights')),
      listBox,
      h('a', { class: `side-account${S.view === 'settings' ? ' on' : ''}`, href: '#/settings' },
        D.userAvatar('sm'),
        h('span', { class: 'acc-text' }, h('b', {}, S.me.user.name), h('span', {}, S.me.account?.email || '설정')),
        D.icon.gear(18)));
  };

  // 폰에서 키보드가 올라오면 앱 높이를 실제로 보이는 영역에 맞춘다 (입력창이 키보드에 가려지지 않게).
  if (window.visualViewport) {
    const fit = () => {
      document.documentElement.style.setProperty('--vvh', `${Math.round(visualViewport.height)}px`);
      if (D.coarse) window.scrollTo(0, 0);
    };
    visualViewport.addEventListener('resize', fit);
    visualViewport.addEventListener('scroll', fit);
    fit();
  }

  // 모바일 서랍
  D.openDrawer = () => { document.body.classList.add('drawer-open'); };
  D.closeDrawer = () => { document.body.classList.remove('drawer-open'); };
  $('scrim').addEventListener('click', D.closeDrawer);
  (() => {
    // 화면 왼쪽 끝에서 오른쪽으로 밀면 서랍이 열린다 (방향이 정해질 때까지 10px 여유)
    let x0 = 0; let y0 = 0; let active = false;
    document.addEventListener('pointerdown', (e) => {
      if (innerWidth >= 900 || e.pointerType === 'mouse' || e.clientX > 24 || document.body.classList.contains('drawer-open')) return;
      active = true; x0 = e.clientX; y0 = e.clientY;
    });
    document.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - x0; const dy = e.clientY - y0;
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      active = false;
      if (dx > Math.abs(dy)) D.openDrawer();
    });
    document.addEventListener('pointerup', () => { active = false; });
  })();

  // 상단 바: 모바일은 메뉴 · 제목 · 새 채팅, 데스크톱은 제목과 대화 메뉴
  D.renderTopbar = () => {
    const titles = { home: '', team: 'AI 팀', memory: '과제·기억', insights: '1명 vs 팀 인사이트', settings: '설정', plugins: '플러그인', automations: '자동화' };
    const room = S.rooms.find((r) => r.id === S.roomId);
    const title = S.view === 'chat' ? room?.name || '' : titles[S.view];
    $('topbar').replaceChildren(
      h('button', { class: 'icon-btn only-mobile', type: 'button', 'aria-label': '메뉴', onclick: D.openDrawer }, D.icon.menu(22)),
      S.view === 'chat' && room
        ? h('button', { class: 'top-title as-button', type: 'button', onclick: () => D.roomSheet(room) }, h('span', {}, title), D.icon.chevron(16))
        : h('div', { class: 'top-title' }, title),
      h('div', { class: 'top-right' },
        S.view === 'chat' ? h('span', { id: 'topStatus', class: 'top-status' }) : null,
        h('button', { class: 'icon-btn only-mobile', type: 'button', 'aria-label': '새 채팅', onclick: () => D.go('#/') }, D.icon.compose(22))));
  };
})();
