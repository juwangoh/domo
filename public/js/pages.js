'use strict';
// 페이지: AI 팀(페르소나 편집) · 과제·기억 · 1명 vs 팀 인사이트 · 설정
(() => {
  const { h, $, S, api, safe } = D;
  const PAGES = { team: renderTeam, memory: renderMemory, insights: renderInsights, settings: renderSettings };

  D.renderPage = (view) => {
    const page = $('view-page');
    const keep = page.dataset.view === view ? page.scrollTop : 0;
    page.dataset.view = view;
    page.replaceChildren(h('div', { class: 'page' }, PAGES[view]()));
    page.scrollTop = keep;
  };
  D.rerenderPage = (views) => { if (views.includes(S.view)) D.renderPage(S.view); };
  const section = (title, note, ...children) => h('section', { class: 'page-section' },
    title ? h('h2', {}, title) : null, note ? h('p', { class: 'page-note' }, note) : null, ...children);
  const head = (title, sub, action) => h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), action || null);

  // ── AI 팀 ────────────────────────────────────
  function renderTeam() {
    const roles = S.me.options.studioRoles;
    const primary = D.primaryId();
    return [
      head('AI 팀', '평소에는 기본 AI 한 명이 답하고, 팀 서비스를 부를 때만 역할별로 함께 일합니다.',
        h('button', { class: 'btn-primary small', type: 'button', onclick: newPersona }, D.icon.plus(16), '새 페르소나')),
      h('div', { class: 'agent-grid' }, D.agents().map((a) => h('button', { class: 'agent-card', type: 'button', onclick: () => agentSheet(a.id) },
        h('div', { class: 'agent-top' }, D.avatarEl(a, 'md'), h('div', { class: 'grow' }, h('b', {}, a.name), h('span', {}, a.title || roles[a.studioRole]?.label || '역할 없음')),
          a.id === primary ? h('span', { class: 'tag pass' }, '기본 AI') : null),
        h('p', {}, roles[a.studioRole]?.desc || '팀 서비스에서 맡는 역할이 없습니다'),
        h('div', { class: 'agent-meta' }, `${D.engineLabel(a.engine)} · ${D.modelLabel(a)} · ${S.me.options.permissions[a.permission]?.label || ''}`)))),
    ];
  }

  function newPersona() {
    D.openSheet({ title: '새 페르소나' }, (body) => body.append(
      h('p', { class: 'sheet-note' }, '역할 템플릿에서 시작하면 맡는 일과 하지 않는 일이 미리 정해져 있어요. 이름과 성격은 바로 바꿀 수 있어요.'),
      h('div', { class: 'menu-list' },
        (S.me.options.templates || []).map((t) => h('button', { class: 'menu-item', type: 'button', onclick: () => { D.closeSheet(); agentSheet(null, t); } },
          h('b', {}, `${t.emoji} ${t.title}`), h('span', {}, t.blurb))),
        h('button', { class: 'menu-item', type: 'button', onclick: () => { D.closeSheet(); agentSheet(null, null); } }, h('b', {}, '빈 페르소나'), h('span', {}, '처음부터 직접 쓰기')))));
  }

  const COLORS = ['#F5A985', '#24364B', '#D97757', '#10A37F', '#5E5CE6', '#BF5AF2', '#30B0C7', '#E8B04A', '#8E8E93'];
  function agentSheet(id, template) {
    const O = S.me.options;
    const exist = id ? D.agent(id) : null;
    const userName = S.me.user.name;
    const base = template
      ? { ...template, soul: template.soul.replaceAll('{name}', template.name).replaceAll('{user}', userName), engine: template.studioRole === 'verifier' && D.agents().some((x) => x.engine === 'codex') ? 'codex' : 'claude', model: '', effort: '', permission: 'read', plugins: [], useMemory: true, avatar: null }
      : { name: '', title: '', emoji: '✨', color: '#F5A985', engine: 'claude', model: '', effort: '', personality: 'default', soul: '', permission: 'read', plugins: [], useMemory: true, avatar: null, studioRole: '' };
    const a = exist ? JSON.parse(JSON.stringify(exist)) : base;
    delete a.id;
    D.openSheet({ title: exist ? a.name : '새 페르소나', done: exist ? '저장' : '만들기', wide: true, onDone: async () => {
      if (!a.name.trim()) { D.toast('이름을 입력하세요.'); return false; }
      const r = await safe(exist ? api('PATCH', `/api/agents/${exist.id}`, a) : api('POST', '/api/agents', a));
      if (!r) return false;
      await D.loadMe();
      D.renderPage('team');
      return true;
    } }, (body) => {
      const face = h('div');
      const drawFace = () => face.replaceChildren(D.avatarEl(a, 'xl'));
      drawFace();
      const swatches = h('div', { class: 'swatches' });
      const drawSw = () => swatches.replaceChildren(...COLORS.map((c) => { const b = h('button', { type: 'button', class: a.color?.toLowerCase() === c.toLowerCase() ? 'on' : '', 'aria-label': `색 ${c}`, onclick: () => { a.color = c; drawFace(); drawSw(); } }); b.style.setProperty('--c', c); return b; }));
      drawSw();
      const modelBtn = h('button', { class: 'btn-secondary small', type: 'button', onclick: () => D.modelPicker(a, () => drawModel()) });
      const drawModel = () => modelBtn.replaceChildren(`${D.modelLabel(a)}${a.effort ? ` · ${a.effort}` : ''}`, D.icon.chevron(13));
      drawModel();
      const plugBox = h('div');
      const drawPlugins = async () => {
        if (a.engine === 'codex') { plugBox.replaceChildren(h('p', { class: 'sheet-note' }, 'Codex는 Codex 앱에 설치된 플러그인을 그대로 씁니다.')); return; }
        if (!S.plugins) {
          plugBox.replaceChildren(h('p', { class: 'sheet-note' }, '연결된 플러그인을 확인하는 중…'));
          const r = await safe(api('GET', '/api/plugins'));
          S.plugins = r?.plugins || [];
        }
        plugBox.replaceChildren(S.plugins.length
          ? D.chips(S.plugins.map((p) => [p.name, p.name.replace(/^claude\.ai /, '').replace(/^plugin:([^:]+):.*/, '$1')]), a.plugins, { multi: true, onChange: (v) => { a.plugins = v; } })
          : h('p', { class: 'sheet-note' }, '연결된 플러그인이 없어요. claude.ai의 커넥터(노션·피그마 등)를 연결하면 여기에 나타납니다.'));
      };
      drawPlugins();
      const permNote = h('p', { class: 'sheet-note' }, O.permissions[a.permission].desc);
      body.append(
        h('div', { class: 'avatar-edit' }, face,
          h('div', { class: 'row-gap' },
            h('button', { class: 'btn-ghost small', type: 'button', onclick: async () => { const img = await D.pickImage(); if (img) { a.avatar = img; drawFace(); } } }, '사진'),
            h('input', { class: 'emoji-input', value: a.emoji || '', maxlength: 4, 'aria-label': '이모지', oninput: (e) => { a.emoji = e.target.value; a.avatar = null; drawFace(); } })),
          swatches),
        h('div', { class: 'form-grid' },
          D.field('이름', h('input', { class: 'auth-input', type: 'text', value: a.name, maxlength: 20, placeholder: '예) 레이', oninput: (e) => { a.name = e.target.value; } })),
          D.field('역할 이름', h('input', { class: 'auth-input', type: 'text', value: a.title || '', maxlength: 30, placeholder: '예) 디자인 크리틱', oninput: (e) => { a.title = e.target.value; } }))),
        h('div', { class: 'sheet-label' }, '팀 서비스에서 맡는 역할'),
        D.chips(Object.entries(O.studioRoles).map(([k, r]) => [k, r.label]), a.studioRole || '', { onChange: (v) => { a.studioRole = v; } }),
        h('div', { class: 'sheet-label' }, '엔진 · 모델'),
        h('div', { class: 'row-gap' }, D.segmented([['claude', 'Claude'], ['codex', 'Codex']], a.engine === 'codex' ? 'codex' : 'claude', (v) => { a.engine = v; a.model = ''; drawModel(); drawPlugins(); }), modelBtn),
        h('div', { class: 'sheet-label' }, '페르소나 (SOUL)'),
        h('textarea', { class: 'auth-input area tall', placeholder: '이 AI가 누구이고, 무엇을 맡고, 무엇을 하지 않는지 적어 주세요.', oninput: (e) => { a.soul = e.target.value; } }, a.soul || ''),
        h('div', { class: 'sheet-label' }, '성격'),
        D.chips(Object.entries(O.personalities).map(([k, p]) => [k, p.label]), a.personality || 'default', { onChange: (v) => { a.personality = v; } }),
        h('div', { class: 'sheet-label' }, '권한'),
        D.segmented(Object.entries(O.permissions).map(([k, p]) => [k, p.label]), a.permission, (v) => { a.permission = v; permNote.textContent = O.permissions[v].desc; }), permNote,
        h('div', { class: 'sheet-label' }, '플러그인'), plugBox,
        h('label', { class: 'switch-row' }, h('span', { class: 'grow' }, h('b', {}, '장기 기억 사용'), h('span', {}, '내 정보·프로젝트·과제를 알고 대화')), D.toggle(a.useMemory, (v) => { a.useMemory = v; })),
        exist ? h('div', { class: 'sheet-actions' },
          exist.id !== D.primaryId() ? h('button', { class: 'btn-ghost small', type: 'button', onclick: async () => { await safe(api('PATCH', '/api/settings', { primaryAgent: exist.id })); await D.loadMe(); D.toast(`${exist.name}을(를) 기본 AI로 정했어요`); D.renderPage('team'); } }, '기본 AI로 정하기') : null,
          h('button', { class: 'btn-ghost small danger', type: 'button', onclick: D.confirmTwice('삭제', async () => { if (await safe(api('DELETE', `/api/agents/${exist.id}`))) { await D.loadMe(); D.closeSheet(); D.renderPage('team'); } }) }, '삭제')) : null);
    });
  }

  // ── 과제·기억 ────────────────────────────────
  function renderMemory() {
    const M = S.memory;
    const tabs = [['tasks', '과제'], ['projects', '프로젝트'], ['skills', '스킬'], ['principles', '내 기준'], ['user', '내 정보'], ['notes', '기억']];
    let content;
    if (!M) content = h('p', { class: 'page-note' }, '불러오는 중…');
    else if (S.memTab === 'tasks') content = taskList(M);
    else if (S.memTab === 'projects') content = projectList(M);
    else if (S.memTab === 'skills') content = skillList();
    else content = factList(M, S.memTab);
    return [
      head('과제·기억', '대화가 끝나면 AI가 내 정보·결정·과제를 정리해 여기에 쌓습니다. 모든 AI가 같은 기억을 씁니다.',
        h('button', { class: 'btn-primary small', type: 'button', onclick: () => memEditor(S.memTab, null) }, D.icon.plus(16), '추가')),
      h('div', { class: 'tab-row' }, D.segmented(tabs, S.memTab, (v) => { S.memTab = v; D.renderPage('memory'); })),
      content,
    ];
  }
  function taskList(M) {
    const open = M.tasks.filter((t) => t.status !== 'done').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    const done = M.tasks.filter((t) => t.status === 'done').sort((a, b) => b.ts - a.ts).slice(0, 15);
    const row = (t) => {
      const p = M.projects.find((x) => x.id === t.projectId);
      const d = D.dueInfo(t.due);
      return h('div', { class: `list-row${t.status === 'done' ? ' done' : ''}` },
        h('button', { class: `checkbox${t.status === 'done' ? ' on' : ''}`, type: 'button', 'aria-label': '완료 표시', onclick: () => safe(api('PATCH', `/api/memory/tasks/${t.id}`, { status: t.status === 'done' ? 'todo' : 'done' })) }),
        h('button', { class: 'grow row-main', type: 'button', onclick: () => memEditor('tasks', t) },
          h('span', { class: 'row-title' }, t.title),
          h('span', { class: 'row-sub' }, [d.text ? h('span', { class: `due ${d.cls}` }, d.text) : null, p ? ` · ${p.name}` : null, t.source ? ` · ${t.source}` : null])));
    };
    if (!M.tasks.length) return h('div', { class: 'empty-state' }, '아직 과제가 없어요. 대화에서 과제를 말하거나 크리틱 리포트의 할 일이 생기면 자동으로 등록됩니다.');
    return [h('div', { class: 'list' }, open.length ? open.map(row) : h('div', { class: 'list-row muted' }, '남은 과제가 없어요')),
      done.length ? [h('h2', { class: 'list-label' }, '완료'), h('div', { class: 'list' }, done.map(row))] : null];
  }
  // 자동 스킬: 반복 작업이 3번 나오면 등록, 개수 제한·오래 안 쓰면 보관
  function skillList() {
    if (!S.skills) {
      safe(api('GET', '/api/skills')).then((r) => { if (r) { S.skills = r; if (S.view === 'memory' && S.memTab === 'skills') D.renderPage('memory'); } });
      return h('p', { class: 'page-note' }, '불러오는 중…');
    }
    const { skills, limits } = S.skills;
    const groups = [['active', '사용 중'], ['candidate', '지켜보는 중'], ['archived', '보관함']];
    const ago = (ts) => (ts ? `${Math.max(0, Math.round((Date.now() - ts) / 864e5))}일 전` : '—');
    const row = (x) => h('div', { class: 'list-row' },
      h('div', { class: 'grow row-main' },
        h('span', { class: 'row-title' }, x.name, ' ', x.pinned ? h('span', { class: 'tag pass' }, '고정') : null),
        h('span', { class: 'row-sub' }, x.status === 'candidate' ? `${x.count}/${limits.activateAt}번 나옴 · ${x.key}` : x.status === 'active' ? `${x.count}번 나옴 · 마지막 사용 ${ago(x.lastUsed)} · ${x.description}` : `${x.archivedWhy || '보관'} · ${x.name}`)),
      h('div', { class: 'row-actions' },
        x.status === 'active' ? h('button', { class: 'btn-ghost small', type: 'button', onclick: () => skillPatch(x, { pinned: !x.pinned }) }, x.pinned ? '고정 해제' : '고정') : null,
        x.status === 'archived' ? h('button', { class: 'btn-ghost small', type: 'button', onclick: () => skillPatch(x, { status: 'active' }) }, '다시 쓰기') : null,
        x.status === 'active' ? h('button', { class: 'btn-ghost small', type: 'button', onclick: () => skillPatch(x, { status: 'archived' }) }, '보관') : null,
        h('button', { class: 'btn-ghost small danger', type: 'button', onclick: D.confirmTwice('삭제', async () => { if (await safe(api('DELETE', `/api/skills/${x.id}`))) { S.skills = null; D.renderPage('memory'); } }) }, '삭제')));
    return [
      h('p', { class: 'page-note' }, `같은 형식의 작업이 ${limits.activateAt}번 나오면 자동으로 스킬이 되고, AI는 다음부터 그 절차대로 일합니다. 사용 중인 스킬은 최대 ${limits.maxActive}개까지 두고, ${limits.archiveDays}일 동안 안 쓰거나 개수가 넘치면 가장 오래 안 쓴 것부터 보관함으로 옮깁니다. 비슷한 작업은 하나로 합칩니다. 고정한 스킬은 보관되지 않아요.`),
      skills.length ? groups.map(([st, label]) => {
        const list = skills.filter((x) => x.status === st);
        return list.length ? [h('h2', { class: 'list-label' }, `${label} · ${list.length}${st === 'active' ? `/${limits.maxActive}` : ''}`), h('div', { class: 'list' }, list.map(row))] : null;
      }) : h('div', { class: 'empty-state' }, '아직 반복된 작업이 없어요. 같은 종류의 부탁을 몇 번 하면 여기에 스킬로 쌓입니다.'),
    ];
  }
  async function skillPatch(x, patch) {
    if (await safe(api('PATCH', `/api/skills/${x.id}`, patch))) { S.skills = null; D.renderPage('memory'); }
  }

  function projectList(M) {
    if (!M.projects.length) return h('div', { class: 'empty-state' }, '진행 중인 프로젝트를 대화에서 이야기하면 자동으로 정리됩니다.');
    return h('div', { class: 'list' }, [...M.projects].sort((a, b) => (a.status === '완료') - (b.status === '완료') || b.ts - a.ts).map((p) => {
      const open = M.tasks.filter((t) => t.projectId === p.id && t.status !== 'done').length;
      return h('button', { class: 'list-row', type: 'button', onclick: () => memEditor('projects', p) },
        h('span', { class: 'grow row-main' }, h('span', { class: 'row-title' }, p.name, ' ', h('span', { class: `tag ${p.status === '진행 중' ? 'pass' : ''}` }, p.status)),
          h('span', { class: 'row-sub' }, `${p.desc ? `${p.desc} · ` : ''}남은 과제 ${open}개`)));
    }));
  }
  function factList(M, kind) {
    const items = [...(M[kind] || [])].reverse();
    const note = { principles: '모든 AI가 가장 먼저 읽는 나의 판단 기준이에요. 크리틱 채점 기준이 되고, 결정 카드에서 고른 이유로 자동으로 배웁니다.', user: 'AI들이 알고 있는 나에 대한 정보예요.', notes: '결정 사항과 다음에 참고할 지식이에요.' }[kind];
    return [h('p', { class: 'page-note' }, note),
      items.length ? h('div', { class: 'list' }, items.map((x) => h('button', { class: 'list-row', type: 'button', onclick: () => memEditor(kind, x) }, h('span', { class: 'grow row-title normal' }, x.text), x.learned ? h('span', { class: 'tag' }, '학습') : null)))
        : h('div', { class: 'empty-state' }, '비어 있어요')];
  }
  function memEditor(kind, item) {
    const isNew = !item;
    const v = item ? { ...item } : kind === 'tasks' ? { title: '', due: '', projectId: null } : kind === 'projects' ? { name: '', desc: '', status: '진행 중' } : { text: '' };
    const titles = { tasks: '과제', projects: '프로젝트', principles: '내 기준', user: '내 정보', notes: '기억' };
    D.openSheet({ title: `${titles[kind]} ${isNew ? '추가' : '편집'}`, done: '저장', onDone: async () => !!(await safe(isNew ? api('POST', `/api/memory/${kind}`, v) : api('PATCH', `/api/memory/${kind}/${item.id}`, v))) }, (body) => {
      if (kind === 'tasks') {
        body.append(
          D.field('과제', h('input', { class: 'auth-input', type: 'text', value: v.title, oninput: (e) => { v.title = e.target.value; } })),
          D.field('기한', h('input', { class: 'auth-input', type: 'date', value: v.due, oninput: (e) => { v.due = e.target.value; } })),
          D.field('프로젝트', h('select', { class: 'auth-input', onchange: (e) => { v.projectId = e.target.value || null; } }, h('option', { value: '' }, '없음'), S.memory.projects.map((p) => h('option', { value: p.id, selected: p.id === v.projectId }, p.name)))));
      } else if (kind === 'projects') {
        body.append(
          D.field('이름', h('input', { class: 'auth-input', type: 'text', value: v.name, oninput: (e) => { v.name = e.target.value; } })),
          D.field('설명', h('textarea', { class: 'auth-input area', oninput: (e) => { v.desc = e.target.value; } }, v.desc || '')),
          h('div', { class: 'sheet-label' }, '상태'),
          D.segmented([['진행 중', '진행 중'], ['보류', '보류'], ['완료', '완료']], v.status, (s) => { v.status = s; }),
          item?.notes?.length ? [h('div', { class: 'sheet-label' }, '진척 메모'), h('ul', { class: 'note-list' }, [...item.notes].reverse().map((n) => h('li', {}, n)))] : null);
      } else {
        body.append(h('textarea', { class: 'auth-input area tall', placeholder: kind === 'principles' ? '예) 기능보다 사용 맥락의 설득을 먼저 본다' : '내용', oninput: (e) => { v.text = e.target.value; } }, v.text || ''));
      }
      if (!isNew) body.append(h('div', { class: 'sheet-actions' }, h('button', { class: 'btn-ghost small danger', type: 'button', onclick: D.confirmTwice('삭제', async () => { if (await safe(api('DELETE', `/api/memory/${kind}/${item.id}`))) D.closeSheet(); }) }, '삭제')));
    });
  }

  // ── 인사이트: 1명 vs 팀 ──────────────────────
  function renderInsights() {
    if (!S.insights) {
      safe(api('GET', '/api/insights')).then((r) => { if (r) { S.insights = r.insights; if (S.view === 'insights') D.renderPage('insights'); } });
      return [head('1명 vs 팀 인사이트'), h('p', { class: 'page-note' }, '불러오는 중…')];
    }
    const I = S.insights;
    S.insights = null; // 다음에 열 때 새로 불러온다
    const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
    const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(0)}초`);
    const usd = (v) => (v == null ? '—' : `$${v.toFixed(3)}`);
    const T = I.total;
    return [
      head('1명 vs 팀 인사이트', '블라인드 비교(/비교)에서 고른 결과예요. 팀이 정말 더 나은지, 어떤 작업에서 그런지 실제 데이터로 확인합니다.',
        h('button', { class: 'btn-primary small', type: 'button', onclick: () => D.startWithPrompt('/비교 ') }, '비교 시작')),
      T.n ? [
        h('div', { class: 'stat-row' },
          h('div', { class: 'stat' }, h('span', {}, '비교한 횟수'), h('b', {}, String(T.n))),
          h('div', { class: 'stat accent' }, h('span', {}, '팀 승률'), h('b', {}, pct(T.teamWinRate))),
          h('div', { class: 'stat' }, h('span', {}, '평균 시간 (1명 / 팀)'), h('b', {}, `${sec(T.singleMs)} / ${sec(T.teamMs)}`))),
        h('div', { class: 'win-bar', role: 'img', 'aria-label': `팀 ${T.team}회, 1명 ${T.single}회, 비슷함 ${T.tie}회` },
          T.team ? h('i', { class: 'team', style: `flex:${T.team}` }, `팀 ${T.team}`) : null,
          T.single ? h('i', { class: 'single', style: `flex:${T.single}` }, `1명 ${T.single}`) : null,
          T.tie ? h('i', { class: 'tie', style: `flex:${T.tie}` }, `비슷 ${T.tie}`) : null),
        section('작업 유형별', '팀은 크리틱·컨셉·리서치에서 60% 이상 이길 것, 일반 질문·글쓰기에서는 1명으로 충분할 것이라는 가설을 확인합니다.',
          h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
            h('thead', {}, h('tr', {}, ['유형', '횟수', '팀 승률', '1명 시간', '팀 시간', '1명 비용', '팀 비용'].map((x) => h('th', {}, x)))),
            h('tbody', {}, Object.entries(I.byKind).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, String(v.n)), h('td', {}, pct(v.teamWinRate)), h('td', {}, sec(v.singleMs)), h('td', {}, sec(v.teamMs)), h('td', {}, usd(v.singleCost)), h('td', {}, usd(v.teamCost)))))))),
        I.recent.length ? section('최근 선택', null, h('div', { class: 'list' }, I.recent.map((r) => h('div', { class: 'list-row' },
          h('span', { class: `tag ${r.winner === 'team' ? 'pass' : ''}` }, r.winner === 'team' ? '팀' : r.winner === 'single' ? '1명' : '비슷'),
          h('span', { class: 'grow row-main' }, h('span', { class: 'row-title normal' }, r.request), h('span', { class: 'row-sub' }, `${r.kind}${r.reason ? ` · ${r.reason}` : ''}`)))))) : null,
      ] : h('div', { class: 'empty-state' }, '아직 비교 기록이 없어요. 입력창에 /비교 뒤에 요청을 적으면, AI 1명과 팀이 따로 답한 결과를 블라인드로 고를 수 있어요.'),
    ];
  }

  // ── 설정 ─────────────────────────────────────
  function renderSettings() {
    const u = S.me.user;
    const c = S.connections;
    const t = S.me.tunnel;
    const st = S.me.settings;
    return [
      head('설정'),
      section('프로필', null,
        h('div', { class: 'profile-row' },
          h('button', { class: 'avatar-btn', type: 'button', 'aria-label': '사진 바꾸기', onclick: async () => { const img = await D.pickImage(); if (img && await safe(api('PATCH', '/api/profile', { avatar: img }))) { await D.loadMe(); D.renderPage('settings'); D.renderSidebar(); } } }, D.userAvatar('lg')),
          h('div', { class: 'grow' }, h('b', {}, u.name), h('span', { class: 'muted' }, S.me.account?.email || '')),
          h('button', { class: 'btn-ghost small', type: 'button', onclick: profileSheet }, '편집'))),
      section('AI 연결', '본인 Claude·ChatGPT 계정으로 로그인하면 바로 쓸 수 있어요. 로그인 정보는 각 공식 앱이 관리하고 DOMO는 보관하지 않습니다.',
        c ? D.connectionCards(c, { onDone: () => D.refreshConnections(true) }) : h('p', { class: 'page-note' }, '확인하는 중…'),
        h('div', { class: 'row-gap' }, h('button', { class: 'btn-ghost small', type: 'button', onclick: async () => { await D.refreshConnections(true); D.renderPage('settings'); } }, '다시 확인'))),
      section('기본 AI', '새 채팅을 시작할 때 답하는 AI예요.',
        D.chips(D.agents().map((a) => [a.id, a.name]), D.primaryId(), { onChange: async (v) => { await safe(api('PATCH', '/api/settings', { primaryAgent: v })); await D.loadMe(); } })),
      section('알림', pushText(), h('div', { class: 'row-gap' },
        S.push === 'on'
          ? [h('button', { class: 'btn-ghost small', type: 'button', onclick: disablePush }, '끄기'), h('button', { class: 'btn-ghost small', type: 'button', onclick: () => safe(api('POST', '/api/push/test')).then((r) => r && D.toast(`${r.sent}대에 보냈어요`)) }, '테스트')]
          : h('button', { class: 'btn-secondary small', type: 'button', disabled: !pushSupported(), onclick: enablePush }, '알림 켜기'))),
      t?.available && !c?.codespace ? section('외부 접속 (LTE)', t.url ? `지금 주소: ${t.url}` : '켜면 밖에서도 폰으로 접속할 수 있는 https 주소가 생겨요. 비밀번호로 보호됩니다.',
        h('label', { class: 'switch-row' }, h('span', { class: 'grow' }, h('b', {}, '외부에서 접속 허용'), h('span', {}, { off: '꺼짐', starting: '연결하는 중…', on: t.fixed ? '연결됨 · 고정 주소' : '연결됨 · 임시 주소', error: t.error || '오류' }[t.status])),
          D.toggle(t.status === 'on' || t.status === 'starting', (v) => safe(api('POST', '/api/tunnel', { on: v })))),
        t.url ? h('button', { class: 'cmd', type: 'button', onclick: () => D.copy(t.url) }, h('code', {}, t.url), D.icon.copy(16)) : null) : null,
      section('로그인 화면 문구', '로그인 화면에서 DOMO 아래에 보이는 한 줄이에요. 비워 두면 기본 문구가 나옵니다.',
        (() => {
          let v = st.tagline || '';
          const inp = h('input', { class: 'auth-input', type: 'text', maxlength: 90, value: v, placeholder: '디자인 전공생을 위한 AI 스튜디오', oninput: (e) => { v = e.target.value; } });
          return h('div', { class: 'inline-form' }, inp, h('button', { class: 'btn-secondary small', type: 'button', onclick: async () => { if (await safe(api('PATCH', '/api/settings', { tagline: v }))) { await D.loadMe(); D.toast('저장했어요'); } } }, '저장'));
        })()),
      section('자동 기억', null,
        h('label', { class: 'switch-row' }, h('span', { class: 'grow' }, h('b', {}, '대화가 끝나면 기억하기'), h('span', {}, '내 정보·프로젝트·과제·대화 요약을 정리')), D.toggle(st.autoMemory, (v) => safe(api('PATCH', '/api/settings', { autoMemory: v }).then(D.loadMe))))),
      section('계정', null, h('div', { class: 'row-gap' },
        h('button', { class: 'btn-ghost small', type: 'button', onclick: passwordSheet }, '비밀번호 변경'),
        h('button', { class: 'btn-ghost small', type: 'button', onclick: () => D.showOnboarding('about') }, '온보딩 다시 하기'),
        h('button', { class: 'btn-ghost small danger', type: 'button', onclick: async () => { await api('POST', '/api/logout').catch(() => {}); D.showAuth(); } }, '로그아웃'))),
      h('p', { class: 'page-foot' }, 'DOMO · Claude Code + Codex 기반 · 디자인 전공생을 위한 AI 스튜디오'),
    ];
  }

  function profileSheet() {
    const v = { name: S.me.user.name, email: S.me.account?.email || '', bio: S.me.user.bio || '' };
    D.openSheet({ title: '프로필', done: '저장', onDone: async () => {
      const r1 = await safe(api('PATCH', '/api/account', { name: v.name, email: v.email }));
      const r2 = await safe(api('PATCH', '/api/profile', { name: v.name, bio: v.bio }));
      if (r1 && r2) { await D.loadMe(); D.renderPage('settings'); D.renderSidebar(); }
      return !!(r1 && r2);
    } }, (body) => body.append(
      D.field('이름', h('input', { class: 'auth-input', type: 'text', value: v.name, maxlength: 30, oninput: (e) => { v.name = e.target.value; } })),
      D.field('이메일', h('input', { class: 'auth-input', type: 'email', value: v.email, oninput: (e) => { v.email = e.target.value; } })),
      D.field('나를 소개하기', h('textarea', { class: 'auth-input area', placeholder: '모든 AI가 참고합니다', oninput: (e) => { v.bio = e.target.value; } }, v.bio))));
  }

  function passwordSheet() {
    const v = { current: '', next: '' };
    D.openSheet({ title: '비밀번호 변경', done: '변경', onDone: async () => {
      const r = await safe(api('POST', '/api/password', v));
      if (r) D.toast('비밀번호를 바꿨어요. 다른 기기는 다시 로그인해야 해요.');
      return !!r;
    } }, (body) => body.append(
      D.field('현재 비밀번호', h('input', { class: 'auth-input', type: 'password', autocomplete: 'current-password', oninput: (e) => { v.current = e.target.value; } })),
      D.field('새 비밀번호', h('input', { class: 'auth-input', type: 'password', autocomplete: 'new-password', oninput: (e) => { v.next = e.target.value; } }))));
  }

  // 웹 푸시 (내 차례·완료 알림)
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  function pushText() {
    if (!pushSupported()) return /iPhone|iPad/.test(navigator.userAgent) ? '아이폰은 홈 화면에 추가한 DOMO 앱에서 켤 수 있어요.' : '이 브라우저는 알림을 지원하지 않아요.';
    if (Notification.permission === 'denied') return '알림이 차단되어 있어요. 기기 설정에서 허용해 주세요.';
    return S.push === 'on' ? '켜짐 · 팀이 내 판단을 기다리거나 작업이 끝나면 알려 드려요.' : '팀이 내 판단을 기다릴 때 폰으로 알려 드려요.';
  }
  D.refreshPush = async () => {
    if (!pushSupported()) { S.push = 'unsupported'; return; }
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      S.push = sub && Notification.permission === 'granted' ? 'on' : 'off';
    } catch { S.push = 'off'; }
  };
  async function enablePush() {
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('알림 권한이 허용되지 않았어요.');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { publicKey } = await api('GET', '/api/push/key');
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)) });
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      S.push = 'on';
      D.toast('알림을 켰어요');
    } catch (err) { S.push = 'off'; if (err.message !== 'login') D.toast(err.message); }
    D.renderPage('settings');
  }
  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    } catch { /* 무시 */ }
    S.push = 'off';
    D.renderPage('settings');
  }

  // 시작
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  D.refreshPush();
  D.boot().catch(() => {});
})();
