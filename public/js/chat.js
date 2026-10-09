'use strict';
// 대화: 빈 화면(인사 + 큰 입력창 + 팀 서비스) · 메시지 · 카드(결정·비교·리포트·연결) · 입력창
(() => {
  const { h, $, S, api, safe } = D;
  const currentRoom = () => S.rooms.find((r) => r.id === S.roomId);
  D.currentRoom = currentRoom;

  // ── 입력창 (빈 화면과 대화 화면이 같은 입력창을 옮겨 쓴다) ─────────
  const input = h('textarea', { id: 'input', rows: 1, placeholder: '무엇을 도와드릴까요?', 'aria-label': '메시지 입력', enterkeyhint: 'send' });
  const sendBtn = h('button', { class: 'send-btn', type: 'submit', 'aria-label': '보내기', disabled: true }, D.icon.up(18));
  const tray = h('div', { class: 'attach-tray', hidden: true });
  const replyBar = h('div', { class: 'reply-bar', hidden: true });
  const aiChip = h('button', { class: 'tool-chip', type: 'button', onclick: () => aiPicker() });
  const teamChip = h('button', { class: 'tool-chip', type: 'button', onclick: () => teamMenu() }, D.icon.spark(15), h('span', {}, '팀', h('span', { class: 'long' }, ' 서비스')));
  const attachInput = h('input', { type: 'file', accept: 'image/*,application/pdf,text/plain,text/markdown,.md,.csv', multiple: true, hidden: true, onchange: (e) => { for (const f of e.target.files) addAttachment(f); e.target.value = ''; } });
  const composer = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); currentRoom()?.running ? stop() : send(); } },
    replyBar, tray,
    h('div', { class: 'composer-box' },
      input,
      h('div', { class: 'composer-row' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '파일·이미지 첨부', onclick: () => attachInput.click() }, D.icon.clip(19)),
        aiChip, teamChip,
        h('span', { class: 'grow' }),
        sendBtn)),
    attachInput);
  D.composer = composer;

  input.addEventListener('input', () => D.syncComposer());
  input.addEventListener('keydown', (e) => {
    // 한글 조합 중 Enter는 글자 확정이므로 보내지 않는다.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !D.coarse) { e.preventDefault(); send(); }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); for (const f of files) addAttachment(f); }
  });

  D.syncComposer = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    const room = currentRoom();
    const running = S.view === 'chat' && room?.running;
    sendBtn.classList.toggle('stop', !!running);
    sendBtn.replaceChildren(running ? D.icon.stop(16) : D.icon.up(18));
    sendBtn.setAttribute('aria-label', running ? '중단' : '보내기');
    sendBtn.disabled = !running && (!input.value.trim() && !S.pending.some((f) => f.id) || S.pending.some((f) => f.uploading));
    const a = D.agent(chatAgentId());
    aiChip.replaceChildren(a ? D.avatarEl(a, 'xs') : '', h('span', {}, a ? [a.name, h('span', { class: 'long' }, ` · ${D.modelLabel(a)}`)] : 'AI 선택'), D.icon.chevron(14));
    const cmd = input.value.match(/^\s*\/(\S+)/)?.[1];
    teamChip.classList.toggle('on', !!cmd);
  };

  // 지금 대화하는 AI: 대화방이면 방의 첫 AI, 빈 화면이면 기본 AI
  const chatAgentId = () => {
    const room = currentRoom();
    if (S.view === 'chat' && room) return room.members[0];
    return S.homeAgent && D.agent(S.homeAgent) ? S.homeAgent : D.primaryId();
  };

  let sending = false;
  async function send() {
    const text = input.value.trim();
    const files = S.pending.filter((f) => f.id).map((f) => f.id);
    if ((!text && !files.length) || sending) return;
    sending = true;
    try {
      // 빈 화면에서 보내면 새 채팅을 만든다 (첨부를 먼저 올렸다면 그때 만든 방을 쓴다).
      let roomId = S.view === 'chat' ? S.roomId : S.draftRoom || null;
      if (!roomId) {
        const { room } = await api('POST', '/api/rooms', { name: '새 채팅', members: [chatAgentId()], mode: 'chat' });
        S.rooms.unshift(room);
        roomId = room.id;
      }
      S.draftRoom = null;
      input.value = '';
      const replyTo = S.replyTo?.id;
      S.pending = [];
      renderTray();
      setReply(null);
      D.syncComposer();
      const { message } = await api('POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, { text, files, replyTo });
      if (S.view !== 'chat' || S.roomId !== roomId) { S.messages = [message]; location.hash = `#/c/${encodeURIComponent(roomId)}`; } else D.onMessage(message);
    } catch (err) {
      if (err.message !== 'login') { input.value = text; D.syncComposer(); D.toast(err.message); }
    } finally { sending = false; }
  }
  D.sendText = (text) => { input.value = text; D.syncComposer(); return send(); };
  const stop = () => safe(api('POST', `/api/rooms/${encodeURIComponent(S.roomId)}/stop`));

  // 온보딩 추천·팀 서비스: 입력창에 시작 문장을 넣고 이어서 쓰게 한다.
  D.startWithPrompt = (prompt) => {
    D.go('#/');
    setTimeout(() => {
      input.value = prompt;
      D.syncComposer();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 50);
  };

  // ── 빈 화면 ──────────────────────────────────
  D.renderHome = () => {
    const now = new Date();
    const hour = now.getHours();
    // 시간대(새벽·아침·오후·저녁)마다 문장 여러 개 중 날짜로 하나를 고른다: 같은 날 같은 시간대에는 같고, 날이 바뀌면 달라진다.
    const GREET = {
      night: ['늦은 시간까지 수고 많아요', '아직 작업 중이네요', '조용한 시간이에요'],
      morning: ['좋은 아침이에요', '오늘은 뭐부터 할까요', '상쾌하게 시작해 볼까요'],
      day: ['안녕하세요', '오후도 힘내요', '어디까지 했는지 볼까요'],
      evening: ['오늘도 수고했어요', '하루 마무리해 볼까요', '저녁에도 함께해요'],
    };
    const slot = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'day' : 'evening';
    const seed = now.getFullYear() * 400 + now.getMonth() * 32 + now.getDate();
    const hello = GREET[slot][seed % GREET[slot].length];
    const services = Object.entries(S.me.team.commands);
    const openTasks = (S.memory?.tasks || []).filter((t) => t.status !== 'done').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 3);
    $('view-home').replaceChildren(h('div', { class: 'home' },
      h('h1', { class: 'hello' }, D.icon.spark(28), h('span', {}, `${hello}, ${S.me.user.name}님`)),
      h('div', { class: 'home-composer' }, composer),
      h('div', { class: 'service-row' }, services.map(([id, c]) => h('button', { class: 'service-chip', type: 'button', title: c.desc, onclick: () => insertCommand(id) }, c.label))),
      openTasks.length ? h('div', { class: 'home-tasks' },
        h('div', { class: 'home-label' }, '다가오는 과제'),
        openTasks.map((t) => { const d = D.dueInfo(t.due); return h('a', { class: 'home-task', href: '#/memory' }, h('span', {}, t.title), d.text ? h('span', { class: `due ${d.cls}` }, d.text) : null); })) : null));
    D.syncComposer();
    if (!D.coarse) setTimeout(() => input.focus(), 30);
  };

  const COMMAND_PREFIX = { critique: '/크리틱 ', concept: '/컨셉 ', research: '/리서치 ', verify: '/검증', compare: '/비교 ' };
  const COMMAND_HINT = {
    critique: '작업 사진이나 PDF를 첨부하고 설명을 적어 주세요. 교수님 기준표가 있으면 "기준:" 아래에 적어 주세요.',
    concept: '주제와 지금 막힌 지점을 적어 주세요. 팀이 먼저 내 1차 가설을 물어봅니다.',
    research: '조사할 주제를 적어 주세요. 출처와 라벨이 붙은 팩트시트로 받습니다.',
    verify: '직전 AI 답을 Codex가 한 번 더 확인합니다. 그대로 보내면 됩니다.',
    compare: '같은 요청을 AI 1명과 팀이 따로 답합니다. 누가 썼는지 모르게 보고 고르세요.',
  };
  function insertCommand(id) {
    const rest = input.value.replace(/^\s*\/\S+\s*/, '');
    input.value = COMMAND_PREFIX[id] + rest;
    D.syncComposer();
    input.focus();
    D.toast(COMMAND_HINT[id]);
  }

  function teamMenu() {
    D.openSheet({ title: '팀 서비스' }, (body) => body.append(
      h('p', { class: 'sheet-note' }, '평소에는 AI 한 명이 답합니다. 아래 일은 팀이 서로를 보지 않고 각자 작업한 뒤 합칩니다.'),
      h('div', { class: 'menu-list' }, Object.entries(S.me.team.commands).map(([id, c]) => h('button', { class: 'menu-item', type: 'button', onclick: () => { D.closeSheet(); insertCommand(id); } },
        h('b', {}, c.label), h('span', {}, c.desc), h('code', {}, COMMAND_PREFIX[id].trim()))))));
  }

  // AI 고르기 + 모델 바꾸기
  function aiPicker() {
    const room = S.view === 'chat' ? currentRoom() : null;
    const current = chatAgentId();
    D.openSheet({ title: '대화할 AI' }, (body) => {
      body.append(
        h('div', { class: 'menu-list' }, D.agents().map((a) => h('div', { class: `pick-row${a.id === current ? ' on' : ''}` },
          h('button', { class: 'pick-main', type: 'button', onclick: async () => {
            if (room && room.members.length === 1 && a.id !== room.members[0]) {
              await safe(api('PATCH', `/api/rooms/${encodeURIComponent(room.id)}`, { members: [a.id] }));
              await D.loadRooms();
            } else if (!room) S.homeAgent = a.id;
            D.closeSheet();
            D.syncComposer();
          } }, D.avatarEl(a, 'sm'), h('span', { class: 'grow' }, h('b', {}, a.name), h('span', {}, `${a.title || S.me.options.studioRoles[a.studioRole]?.label || ''} · ${D.engineLabel(a.engine)}`))),
          h('button', { class: 'model-btn', type: 'button', onclick: () => D.modelPicker(a, () => { D.syncComposer(); D.renderChatHeader(); }, { save: true }) }, D.modelLabel(a), D.icon.chevron(13))))),
        room && room.members.length > 1 ? h('p', { class: 'sheet-note' }, '이 대화는 여러 AI가 함께 하는 방입니다. 참여 AI는 상단 제목을 눌러 바꿀 수 있어요.') : null);
    });
  }

  // 모델 선택 (AI 팀 화면과 공용)
  D.modelPicker = (a, onPick, { save = false } = {}) => {
    const O = S.me.options;
    const pick = { model: a.model, effort: a.effort || '' };
    D.openSheet({ title: `${a.name} 모델`, done: '완료', onDone: async () => {
      if (save) {
        const r = await safe(api('PATCH', `/api/agents/${a.id}`, pick));
        if (!r) return false;
        await D.loadMe();
        D.toast(`${a.name} → ${D.modelLabel(r.agent)}`);
      } else Object.assign(a, pick);
      onPick?.(a);
      return true;
    } }, (body) => {
      const list = h('div', { class: 'menu-list' });
      const draw = () => list.replaceChildren(...(O.models[a.engine] || []).map((m) => h('button', { class: `pick-row single${pick.model === m.id ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(pick.model === m.id), onclick: () => { pick.model = m.id; draw(); } },
        h('span', { class: 'grow' }, h('b', {}, m.label), h('span', {}, m.desc)), pick.model === m.id ? h('span', { class: 'check-mark' }, '✓') : null)));
      draw();
      body.append(list,
        h('div', { class: 'sheet-label' }, '추론 강도'),
        D.segmented(O.efforts.map((e) => [e, e ? { low: '낮음', medium: '보통', high: '높음' }[e] : '기본']), pick.effort, (v) => { pick.effort = v; }),
        h('p', { class: 'sheet-note' }, '다음 답부터 적용됩니다. 높은 모델일수록 느리고 사용량이 많아요.'));
    });
  };

  // ── 대화 열기 ────────────────────────────────
  D.openRoom = async (id, { keepScroll = false } = {}) => {
    const switching = S.roomId !== id;
    S.roomId = id;
    S.unread[id] = 0;
    $('chatComposer').append(composer);
    if (switching) { if (!S.messages.length || S.messages[0]?.roomId !== id) S.messages = []; D.renderMessages(); setReply(null); }
    D.renderChatHeader();
    D.renderTopbar();
    D.syncComposer();
    try {
      const data = await api('GET', `/api/rooms/${encodeURIComponent(id)}/messages`);
      if (S.roomId !== id) return;
      S.messages = data.messages;
      const room = currentRoom();
      if (room) room.running = data.running;
      D.renderMessages();
      D.renderChatHeader();
      D.syncComposer();
      if (!keepScroll || nearBottom()) scrollToBottom(false);
    } catch (err) { if (err.message !== 'login') D.toast(err.message); }
    if (!D.coarse && switching) input.focus();
  };

  D.onMessage = (msg) => {
    const room = S.rooms.find((r) => r.id === msg.roomId);
    if (room) room.last = msg;
    if (msg.roomId === S.roomId && S.view === 'chat') {
      if (!S.messages.some((m) => m.id === msg.id)) {
        const stick = nearBottom();
        S.messages.push(msg);
        D.renderMessages(msg.id);
        if (stick || msg.sender === 'user') scrollToBottom(true); else $('jumpBtn').hidden = false;
      }
    } else if (msg.sender !== 'user' && msg.sender !== 'system') S.unread[msg.roomId] = (S.unread[msg.roomId] || 0) + 1;
    S.rooms.sort((a, b) => (b.last?.ts || b.createdAt) - (a.last?.ts || a.createdAt));
    D.renderSidebar();
  };
  D.onUpdate = (msg) => {
    const i = S.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0 && msg.roomId === S.roomId) { S.messages[i] = msg; D.renderMessages(); }
  };

  const STAGE_NAMES = ['브리프', '발산', '방향', '시안', '완료'];
  const STAGE_IDS = ['brief', 'diverge', 'decide', 'produce', 'done'];
  D.renderChatHeader = () => {
    const room = currentRoom();
    const strip = $('projectStrip');
    if (!room) { strip.hidden = true; return; }
    const typing = [...(S.typing[room.id] || [])];
    const status = $('topStatus');
    if (status) status.textContent = typing.length ? `${typing.map(D.name).join(', ')} · ${S.activity[room.id]?.[typing[0]]?.label || '생각 중'}` : '';
    const P = room.project;
    strip.hidden = !P || P.stage === 'done';
    if (P && P.stage !== 'done') {
      const at = STAGE_IDS.indexOf(P.stage);
      strip.replaceChildren(
        h('span', { class: 'strip-title' }, P.title || '스튜디오 프로젝트'),
        h('span', { class: 'strip-steps' }, STAGE_NAMES.map((n, i) => h('span', { class: i < at ? 'done' : i === at ? 'now' : '' }, n))),
        P.awaiting && !room.running ? h('span', { class: 'strip-wait' }, '내 차례') : null,
        h('button', { class: 'link-btn', type: 'button', onclick: D.confirmTwice('닫기', () => safe(api('POST', `/api/rooms/${encodeURIComponent(room.id)}/project/cancel`))) }, '닫기'));
    }
  };

  // ── 메시지 ───────────────────────────────────
  D.renderMessages = (newId) => {
    const room = currentRoom();
    const box = $('messages');
    const frag = document.createDocumentFragment();
    const col = h('div', { class: 'thread' });
    if (!S.messages.length && room) col.append(h('div', { class: 'thread-empty' }, room.members.length > 1 ? `${room.members.map(D.name).join(', ')}와 함께하는 대화입니다.` : `${D.name(room.members[0])}와 대화를 시작하세요.`));
    for (const m of S.messages) col.append(renderOne(m, room, m.id === newId));
    col.append(h('div', { id: 'typingRows' }));
    frag.append(col);
    box.replaceChildren(frag);
    D.renderTyping();
  };

  function renderOne(m, room, isNew) {
    if (m.sender === 'system') return systemBlock(m, room);
    if (m.sender === 'user') {
      return h('div', { class: `msg-user${isNew ? ' enter' : ''}` },
        m.meta?.scheduled ? h('div', { class: 'msg-note' }, `⏰ 예약 · ${m.meta.scheduleName || ''}`) : null,
        m.meta?.reply ? h('div', { class: 'quote' }, h('b', {}, D.name(m.meta.reply.sender)), ` ${m.meta.reply.excerpt}`) : null,
        m.meta?.files?.length ? fileGrid(m.meta.files) : null,
        m.text && m.text !== '(첨부)' ? h('div', { class: 'user-bubble', html: commandHtml(m.text) }) : null);
    }
    const a = D.agent(m.sender);
    const meta = m.meta || {};
    const body = h('div', { class: 'ai-body' });
    if (meta.kind === 'minutes' || meta.kind === 'team-report') buildReport(body, m);
    else body.innerHTML = D.markdown(m.text);
    const chips = [
      meta.label ? h('span', { class: 'tag' }, meta.label) : null,
      meta.verdict ? h('span', { class: `tag ${meta.verdict}` }, meta.verdict === 'pass' ? '✓ 문제 없음' : '↺ 수정 필요') : null,
      meta.stance ? h('span', { class: `tag ${meta.stance === 'agree' ? 'pass' : 'revise'}` }, meta.stance === 'agree' ? '합의' : '이견') : null,
    ];
    const head = h('div', { class: 'ai-head' }, D.avatarEl(a, 'xs'), h('b', {}, D.name(m.sender)), chips);
    const foot = h('div', { class: 'ai-foot' },
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': '복사', title: '복사', onclick: () => D.copy(m.text) }, D.icon.copy(16)),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': '답장', title: '답장', onclick: () => setReply(m) }, D.icon.reply(16)),
      h('span', { class: 'ai-meta' }, [D.fmtTime(m.ts), meta.model ? D.modelLabel({ engine: a?.engine, model: meta.model }) : '', meta.ms ? `${(meta.ms / 1000).toFixed(1)}초` : '', meta.costUsd ? `$${meta.costUsd.toFixed(3)}` : ''].filter(Boolean).join(' · ')));
    if (meta.collapsed) {
      return h('details', { class: `msg-ai collapsed${isNew ? ' enter' : ''}` },
        h('summary', {}, D.avatarEl(a, 'xs'), h('b', {}, meta.label || D.name(m.sender)), h('span', { class: 'muted' }, ` · ${D.name(m.sender)}`), h('span', { class: 'summary-hint' }, '펼쳐 보기')),
        body, foot);
    }
    return h('div', { class: `msg-ai${isNew ? ' enter' : ''}` }, head, body, foot);
  }

  // 사용자 메시지 앞의 /명령을 강조
  const commandHtml = (text) => D.esc(text).replace(/^(\/\S+)/, '<span class="cmd-tag">$1</span>').replace(/\n/g, '<br>');

  function systemBlock(m, room) {
    const k = m.meta?.kind;
    if (k === 'gate') return gateCard(m, room);
    if (k === 'compare') return compareCard(m, room);
    if (k === 'error' && m.meta?.needsLogin) {
      return h('div', { class: 'card warn' },
        h('b', {}, 'AI 연결이 필요해요'),
        h('p', {}, m.text),
        h('div', { class: 'card-actions' }, h('a', { class: 'btn-primary small', href: '#/settings' }, 'AI 연결 열기')));
    }
    return h('div', { class: `sys ${k || ''}` }, m.text);
  }

  // 회의록·작업 보고·크리틱 리포트: 본문 + 할 일(기억 탭 과제와 연결)
  function buildReport(body, m) {
    body.classList.add('report');
    const text = m.text.replace(/^\s*[-*]\s*\[\s?\]\s*.+$/gm, '').replace(/##\s*(할 일|다음 행동|남은 일)\s*$/m, '').trim();
    body.innerHTML = D.markdown(text);
    const tasks = (m.meta.tasks || []).map((id) => S.memory?.tasks.find((t) => t.id === id)).filter(Boolean);
    if (!tasks.length) return;
    body.append(h('div', { class: 'report-tasks' }, h('div', { class: 'report-label' }, '할 일 · 과제에 등록됨'), tasks.map((t) => {
      const d = D.dueInfo(t.due);
      return h('button', { class: `task-line${t.status === 'done' ? ' done' : ''}`, type: 'button', onclick: () => safe(api('PATCH', `/api/memory/tasks/${t.id}`, { status: t.status === 'done' ? 'todo' : 'done' })) },
        h('span', { class: `checkbox${t.status === 'done' ? ' on' : ''}` }), h('span', { class: 'grow' }, t.title), d.text ? h('span', { class: `due ${d.cls}` }, d.text) : null);
    })));
  }

  // 컨펌 카드 (스튜디오 · 내 차례)
  function gateCard(m, room) {
    const live = room?.project?.awaiting === m.meta.gate && !room.running && S.messages.at(-1)?.id === m.id;
    const options = m.meta.gate === 'B' ? decisionOptions(m) : [];
    if (options.length) return decisionCard(m, options, live);
    return h('div', { class: `card gate${live ? ' live' : ''}` },
      h('b', {}, `${live ? '● ' : ''}${m.meta.title || '내 차례'}`),
      h('p', {}, m.text),
      live ? h('div', { class: 'card-actions' }, (m.meta.actions || []).map((x) => h('button', { class: 'btn-secondary small', type: 'button', onclick: () => D.sendText(x.send) }, x.label)),
        h('button', { class: 'btn-ghost small', type: 'button', onclick: () => input.focus() }, '직접 쓰기')) : null);
  }
  function decisionOptions(gateMsg) {
    const before = S.messages.filter((x) => x.id < gateMsg.id);
    const decision = [...before].reverse().find((x) => x.meta?.studio === 'decision');
    if (!decision) return [];
    const critique = [...before].reverse().find((x) => x.meta?.studio === 'critique');
    const scores = {};
    if (critique) {
      const rows = critique.text.split('\n').filter((l) => /^\s*\|/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const head = rows[0] || [];
      for (const r of rows.slice(1)) {
        head.forEach((col, i) => {
          const letter = col.replace(/[^A-E]/g, '');
          const v = parseFloat(r[i]);
          if (letter.length === 1 && Number.isFinite(v)) (scores[letter] ||= []).push(v);
        });
      }
    }
    const rec = decision.text.match(/팀 추천\s*[:：]?\s*\**\s*([A-E])/)?.[1];
    return decision.text.split(/^#{2,4}\s+/m).slice(1).map((chunk) => {
      const [first, ...rest] = chunk.trim().split('\n');
      const letter = first.match(/^\**([A-E])/)?.[1];
      if (!letter) return null;
      const [nm, summary] = first.replace(/^\**[A-E]\s*(안)?\s*[·.:)\-]?\s*/, '').replace(/\*\*/g, '').split(/\s+[—–-]\s+/);
      const bullets = rest.map((l) => l.replace(/^\s*[-*•]\s*/, '').replace(/\*\*/g, '').trim()).filter((l) => l && !/^팀 추천|^이견|^사실 리스크/.test(l)).slice(0, 3);
      const sc = scores[letter];
      return { letter, name: nm?.trim(), summary: summary?.trim(), bullets, score: sc?.length ? sc.reduce((x, y) => x + y, 0) / sc.length : null, rec: letter === rec };
    }).filter(Boolean);
  }
  function decisionCard(m, options, live) {
    let picked = null;
    const why = h('input', { type: 'text', class: 'why-input', placeholder: '왜 이 안인가요? 적으면 내 기준으로 배웁니다' });
    const go = h('button', { type: 'button', class: 'btn-primary small', disabled: true, onclick: () => D.sendText(`${picked}안으로 진행${why.value.trim() ? ` — 이유: ${why.value.trim()}` : ''}`) }, '이 안으로 진행');
    const cards = options.map((o) => {
      const el = h('button', { type: 'button', class: `opt${o.rec ? ' rec' : ''}`, disabled: !live, onclick: () => {
        picked = o.letter;
        for (const c of cards) c.classList.toggle('on', c === el);
        go.disabled = false;
        go.textContent = `${o.letter}안으로 진행`;
        why.focus();
      } },
        h('div', { class: 'opt-head' }, h('span', { class: 'opt-letter' }, o.letter), o.rec ? h('span', { class: 'tag pass' }, '팀 추천') : null),
        h('b', {}, o.name || `${o.letter}안`),
        o.summary ? h('p', {}, o.summary) : null,
        h('ul', {}, o.bullets.map((x) => h('li', {}, x))),
        o.score != null ? h('div', { class: 'opt-score' }, h('span', { class: 'bar' }, h('i', { style: `width:${Math.round((o.score / 5) * 100)}%` })), h('span', {}, `내 기준 ${o.score.toFixed(1)}`)) : null);
      return el;
    });
    return h('div', { class: `card gate decision${live ? ' live' : ''}` },
      h('b', {}, `${live ? '● ' : ''}${m.meta.title || '방향 선택'}`),
      h('p', {}, live ? '카드를 고르고 이유를 한 줄 적어 주세요. 고쳐서 가고 싶으면 입력창에 직접 쓰세요.' : '선택이 끝난 결정입니다.'),
      h('div', { class: 'opt-row' }, cards),
      live ? h('div', { class: 'why-row' }, why, go) : null);
  }

  // 블라인드 비교 카드: A/B 를 나란히, 고르면 누가 썼는지 공개
  function compareCard(m, room) {
    const meta = m.meta;
    const chosen = meta.choice;
    const reveal = meta.reveal;
    const label = (side) => (side === 'team' ? '팀' : 'AI 1명');
    const reason = h('input', { type: 'text', class: 'why-input', placeholder: '고른 이유 한 줄 (선택)' });
    const choose = (choice) => safe(api('POST', `/api/evals/${meta.evalId}/choose`, { roomId: room.id, choice, reason: reason.value.trim() }));
    const side = (key) => h('div', { class: `cmp-side${chosen === key ? ' on' : ''}` },
      h('div', { class: 'cmp-head' }, h('span', { class: 'opt-letter' }, key), reveal ? h('span', { class: `tag ${reveal[key] === 'team' ? 'pass' : ''}` }, label(reveal[key])) : null),
      h('div', { class: 'ai-body', html: D.markdown(meta.options[key]) }),
      !chosen ? h('button', { class: 'btn-secondary small', type: 'button', onclick: () => choose(key) }, `${key}가 더 나아요`) : null);
    return h('div', { class: 'card compare' },
      h('b', {}, chosen ? '블라인드 비교 결과' : '블라인드 비교 · 더 나은 답을 고르세요'),
      h('p', {}, chosen ? (chosen === 'tie' ? '비슷하다고 고르셨어요.' : `${chosen}를 고르셨어요 · ${label(reveal[chosen])}의 답이었습니다.`) : '누가 썼는지는 고른 뒤에 공개됩니다. 결과는 인사이트에 쌓입니다.'),
      h('div', { class: 'cmp-row' }, side('A'), side('B')),
      !chosen ? h('div', { class: 'why-row' }, reason, h('button', { class: 'btn-ghost small', type: 'button', onclick: () => choose('tie') }, '비슷해요')) : null);
  }

  function fileGrid(files) {
    return h('div', { class: 'file-grid' }, files.map((f) => (f.image
      ? h('a', { href: f.url, target: '_blank', rel: 'noopener', class: 'file-img' }, h('img', { src: f.url, alt: f.name, loading: 'lazy' }))
      : h('a', { href: f.url, target: '_blank', rel: 'noopener', class: 'file-chip' }, `📄 ${f.name}`))));
  }

  // 진행 중: 누가 무엇을 하는지 + 쓰고 있는 글
  D.renderTyping = () => {
    const holder = $('typingRows');
    if (!holder) return;
    const set = S.typing[S.roomId];
    holder.replaceChildren();
    if (!set?.size) return;
    const stick = nearBottom();
    for (const id of set) {
      const act = S.activity[S.roomId]?.[id];
      const live = act?.text?.trim();
      holder.append(h('div', { class: 'msg-ai working' },
        h('div', { class: 'ai-head' }, D.avatarEl(D.agent(id), 'xs'), h('b', {}, D.name(id)), h('span', { class: 'working-label' }, h('span', { class: 'pulse' }), act?.label || '생각 중')),
        live ? h('div', { class: 'ai-body live', html: D.markdown(live.length > 900 ? `…${live.slice(-900)}` : live) }) : null));
    }
    if (stick) scrollToBottom(true);
  };

  const nearBottom = () => { const b = $('messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 160; };
  function scrollToBottom(smooth) {
    requestAnimationFrame(() => {
      const b = $('messages');
      b.scrollTo({ top: b.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      $('jumpBtn').hidden = true;
    });
  }
  $('messages').addEventListener('scroll', () => { if (nearBottom()) $('jumpBtn').hidden = true; }, { passive: true });
  $('jumpBtn').addEventListener('click', () => scrollToBottom(true));

  // ── 답장 · 첨부 ──────────────────────────────
  function setReply(m) {
    S.replyTo = m ? { id: m.id, sender: m.sender } : null;
    replyBar.hidden = !m;
    if (m) {
      replyBar.replaceChildren(h('span', { class: 'grow' }, h('b', {}, `${D.name(m.sender)}에게 답장`), h('span', {}, D.plain(m.text).slice(0, 80))),
        h('button', { class: 'icon-btn small', type: 'button', 'aria-label': '답장 취소', onclick: () => setReply(null) }, '✕'));
      input.focus();
    }
  }

  function shrinkImage(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 2000 / Math.max(img.width, img.height));
        if (k === 1 && file.size < 1_500_000) { URL.revokeObjectURL(url); const r = new FileReader(); r.onload = () => resolve({ data: r.result, type: file.type }); r.readAsDataURL(file); return; }
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ data: c.toDataURL('image/jpeg', 0.86), type: 'image/jpeg' });
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  async function addAttachment(file) {
    if (S.pending.length >= 8) { D.toast('한 번에 8개까지 첨부할 수 있어요.'); return; }
    const item = { name: file.name || '붙여넣은 이미지.png', image: file.type.startsWith('image/'), uploading: true, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
    S.pending.push(item);
    renderTray();
    try {
      // 빈 화면에서 첨부하면 먼저 새 채팅을 만든다 (첨부는 대화방 폴더에 저장된다).
      if (S.view !== 'chat' && !S.draftRoom) {
        const { room } = await api('POST', '/api/rooms', { name: '새 채팅', members: [chatAgentId()], mode: 'chat' });
        S.draftRoom = room.id;
      }
      const roomId = S.view === 'chat' ? S.roomId : S.draftRoom;
      const payload = item.image ? await shrinkImage(file) : await new Promise((res) => { const r = new FileReader(); r.onload = () => res({ data: r.result, type: file.type || 'text/plain' }); r.readAsDataURL(file); });
      if (!payload) throw new Error('파일을 읽을 수 없습니다.');
      const { file: saved } = await api('POST', `/api/rooms/${encodeURIComponent(roomId)}/upload`, { name: item.name, ...payload });
      Object.assign(item, { id: saved.id, uploading: false });
    } catch (err) {
      S.pending = S.pending.filter((x) => x !== item);
      if (err.message !== 'login') D.toast(err.message);
    }
    renderTray();
  }
  function renderTray() {
    tray.hidden = !S.pending.length;
    tray.replaceChildren(...S.pending.map((f) => h('div', { class: `tray-item${f.uploading ? ' loading' : ''}` },
      f.preview ? h('img', { src: f.preview, alt: '' }) : h('span', { class: 'tray-file' }, '📄'),
      h('span', { class: 'tray-name' }, f.name),
      h('button', { type: 'button', 'aria-label': '첨부 빼기', onclick: () => { S.pending = S.pending.filter((x) => x !== f); renderTray(); } }, '✕'))));
    D.syncComposer();
  }

  // ── 대화 정보: 이름 · 참여 AI · 삭제 ───────────
  D.roomSheet = (room) => {
    const v = { name: room.name, members: [...room.members] };
    D.openSheet({ title: '대화 정보', done: '저장', onDone: async () => {
      if (!v.members.length) { D.toast('AI를 한 명 이상 선택하세요.'); return false; }
      const r = await safe(api('PATCH', `/api/rooms/${encodeURIComponent(room.id)}`, { name: v.name, members: v.members, mode: v.members.length > 1 ? (room.mode === 'chat' ? 'review' : room.mode) : 'chat' }));
      if (r) await D.loadRooms();
      D.renderTopbar();
      return !!r;
    } }, (body) => {
      const list = h('div', { class: 'menu-list' });
      const draw = () => list.replaceChildren(...D.agents().map((a) => {
        const on = v.members.includes(a.id);
        return h('button', { class: `pick-row single${on ? ' on' : ''}`, type: 'button', role: 'checkbox', 'aria-checked': String(on), onclick: () => {
          v.members = on ? v.members.filter((x) => x !== a.id) : [...v.members, a.id];
          draw();
        } }, D.avatarEl(a, 'sm'), h('span', { class: 'grow' }, h('b', {}, a.name), h('span', {}, `${a.title || ''} · ${D.modelLabel(a)}`)), on ? h('span', { class: 'check-mark' }, '✓') : null);
      }));
      draw();
      body.append(
        D.field('제목', h('input', { class: 'auth-input', type: 'text', value: v.name, maxlength: 60, oninput: (e) => { v.name = e.target.value; } })),
        h('div', { class: 'sheet-label' }, '참여 AI'),
        h('p', { class: 'sheet-note' }, '한 명이면 일반 대화, 여러 명이면 검토 방이 됩니다. 팀이 필요한 순간에는 팀 서비스를 쓰는 것이 더 빠르고 정확해요.'),
        list,
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn-ghost small', type: 'button', onclick: async () => { const r = await safe(api('POST', `/api/rooms/${encodeURIComponent(room.id)}/remember`)); if (r) D.toast(r.applied ? `${r.applied}개 항목을 기억했어요` : '새로 기억할 내용이 없어요'); } }, '지금 대화 기억하기'),
          h('button', { class: 'btn-ghost small danger', type: 'button', onclick: D.confirmTwice('대화 삭제', async () => {
            if (await safe(api('DELETE', `/api/rooms/${encodeURIComponent(room.id)}`))) { D.closeSheet(); D.go('#/'); }
          }) }, '대화 삭제')));
    });
  };
})();
