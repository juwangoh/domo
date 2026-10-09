'use strict';
// 공용: 상태 · API · DOM 헬퍼 · 아바타 · 시트(드래그로 닫기) · 마크다운 · 날짜
(() => {
  const D = (window.D = {});
  D.$ = (id) => document.getElementById(id);
  D.S = {
    me: null, // { user, account, agents, settings, options, team, tunnel }
    rooms: [],
    roomId: null,
    view: 'home', // home | chat | team | memory | insights | settings
    messages: [],
    typing: {},
    activity: {},
    unread: {},
    memory: null,
    plugins: null,
    schedules: [],
    connections: null,
    insights: null,
    pending: [], // 첨부 대기
    replyTo: null,
    push: 'off',
    memTab: 'tasks',
    es: null,
  };
  D.coarse = matchMedia('(pointer: coarse)').matches;

  D.api = async function api(method, path, body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !['/api/login', '/api/signup', '/api/setup'].includes(path)) { D.showAuth?.(); throw new Error('login'); }
    if (!res.ok) throw new Error(data.error || `오류 ${res.status}`);
    return data;
  };
  D.safe = (p) => p.catch((e) => { if (e.message !== 'login') D.toast(e.message); return null; });

  D.h = function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
    return el;
  };
  const { h } = D;

  D.toast = (text) => {
    document.querySelector('.toast')?.remove();
    const t = h('div', { class: 'toast', role: 'status' }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
  };
  D.copy = async (text) => {
    try { await navigator.clipboard.writeText(text); D.toast('복사했습니다'); } catch { D.toast('복사하지 못했습니다'); }
  };

  D.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  D.plain = (s) => String(s).replace(/```[\s\S]*?```/g, '[코드]').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim();
  D.agents = () => D.S.me?.agents || [];
  D.agent = (id) => D.agents().find((a) => a.id === id);
  D.name = (id) => (id === 'user' ? D.S.me.user.name : D.agent(id)?.name || '(삭제된 프로필)');
  D.modelLabel = (a) => {
    const list = D.S.me.options.models[a?.engine] || [];
    return list.find((m) => m.id === a?.model)?.label || a?.model || '기본값';
  };
  D.engineLabel = (e) => ({ claude: 'Claude', codex: 'Codex', mock: '테스트' }[e] || e);
  D.primaryId = () => {
    const id = D.S.me.settings.primaryAgent;
    return D.agent(id) ? id : (D.agents().find((a) => a.engine === 'claude') || D.agents()[0])?.id;
  };

  // 아바타: 사진이 있으면 사진, 없으면 이모지·첫 글자
  D.avatarEl = (p, size = '') => {
    const el = h('span', { class: `avatar ${size}`, 'aria-hidden': 'true' });
    el.style.setProperty('--c', p?.color || '#24364b');
    if (p?.avatar) el.append(h('img', { src: p.avatar, alt: '' }));
    else el.append(h('span', { class: 'glyph' }, p?.emoji || (p?.name || '?')[0]));
    return el;
  };
  D.userAvatar = (size) => D.avatarEl({ ...D.S.me.user, color: '#24364b', emoji: (D.S.me.user.name || '나')[0] }, size);

  // ── 공용 컨트롤 ──────────────────────────────
  D.segmented = (options, value, onChange) => {
    const wrap = h('div', { class: 'segmented', role: 'tablist' });
    const draw = () => wrap.replaceChildren(...options.map(([v, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(v === value), class: v === value ? 'on' : '',
      onclick: () => { value = v; draw(); onChange(v); },
    }, label)));
    draw();
    return wrap;
  };
  D.toggle = (checked, onChange, disabled) => h('span', { class: 'switch' },
    h('input', { type: 'checkbox', role: 'switch', checked: !!checked, disabled: !!disabled, onchange: (e) => onChange(e.target.checked) }), h('span'));
  D.chips = (options, selected, { multi = false, onChange }) => {
    const wrap = h('div', { class: 'chips' });
    let sel = multi ? [...selected] : selected;
    const draw = () => wrap.replaceChildren(...options.map(([v, label]) => {
      const on = multi ? sel.includes(v) : sel === v;
      return h('button', { type: 'button', class: `chip-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: () => {
        sel = multi ? (on ? sel.filter((x) => x !== v) : [...sel, v]) : v;
        draw();
        onChange(sel);
      } }, label);
    }));
    draw();
    return wrap;
  };
  D.confirmTwice = (label, fn) => (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = `한 번 더 누르면 ${label}`;
      setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = label; }, 3000);
      return;
    }
    fn();
  };
  D.field = (label, input) => h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, label), input);

  // ── 시트 (모달) : 모바일은 아래에서 올라오고 손으로 끌어 닫는다 ─────────
  const sheets = [];
  D.openSheet = ({ title, done, onDone, cancel = '취소', wide = false }, build) => {
    const scrim = h('div', { class: 'sheet-scrim' });
    const doneBtn = done ? h('button', { class: 'link-btn strong', type: 'button' }, done) : h('span');
    const body = h('div', { class: 'sheet-body' });
    const sheet = h('section', { class: `sheet${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-grip' }),
      h('div', { class: 'sheet-head' }, h('button', { class: 'link-btn', type: 'button', onclick: () => D.closeSheet() }, done ? cancel : '닫기'), h('h2', {}, title), doneBtn),
      body);
    const entry = { sheet, scrim };
    sheets.push(entry);
    scrim.style.zIndex = 40 + sheets.length * 2;
    sheet.style.zIndex = 41 + sheets.length * 2;
    scrim.addEventListener('click', () => D.closeSheet());
    if (done) {
      doneBtn.addEventListener('click', async () => {
        doneBtn.disabled = true;
        const ok = await onDone();
        doneBtn.disabled = false;
        if (ok !== false) D.closeSheet();
      });
    }
    build(body);
    document.body.append(scrim, sheet);
    dragToClose(entry);
    return entry;
  };
  D.closeSheet = () => {
    const entry = sheets.pop();
    if (!entry) return;
    const { sheet, scrim } = entry;
    sheet.classList.add('leaving');
    scrim.classList.add('leaving');
    setTimeout(() => { sheet.remove(); scrim.remove(); }, 260);
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheets.length) D.closeSheet(); });

  // 손가락을 따라 1:1로 내려가고, 놓을 때 속도로 끝 위치를 예측해 닫을지 정한다.
  function dragToClose({ sheet, scrim }) {
    const handles = [sheet.querySelector('.sheet-grip'), sheet.querySelector('.sheet-head')];
    let startY = 0; let dy = 0; let hist = []; let dragging = false;
    const down = (e) => {
      if (e.pointerType === 'mouse' || (e.target.closest('button') && !e.target.classList.contains('sheet-grip'))) return;
      dragging = true; startY = e.clientY; dy = 0; hist = [{ y: e.clientY, t: performance.now() }];
      sheet.style.transition = 'none';
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      const raw = e.clientY - startY;
      dy = raw >= 0 ? raw : -((-raw * sheet.offsetHeight * 0.55) / (sheet.offsetHeight + 0.55 * -raw));
      sheet.style.transform = `translateY(${dy}px)`;
      scrim.style.opacity = String(1 - Math.max(0, dy) / sheet.offsetHeight);
      hist.push({ y: e.clientY, t: performance.now() });
      if (hist.length > 5) hist.shift();
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      const a = hist[0]; const b = hist.at(-1);
      const v = b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0;
      const projected = dy + (v / 1000) * 0.99 / (1 - 0.99);
      sheet.style.transition = '';
      if (projected > sheet.offsetHeight * 0.4 && dy > 0 && sheets.at(-1)?.sheet === sheet) D.closeSheet();
      else { sheet.style.transform = ''; scrim.style.opacity = ''; }
    };
    for (const el of handles) {
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
  }

  // ── 사진 고르기 (256px 정사각형으로 줄여서 저장) ───────────────
  D.pickImage = () => new Promise((resolve) => {
    const input = D.$('fileInput');
    input.value = '';
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => { D.toast('이미지를 읽을 수 없습니다.'); resolve(null); };
      img.src = URL.createObjectURL(f);
    };
    input.click();
  });

  // ── 마크다운 (먼저 전부 이스케이프한 뒤 허용된 문법만 태그로) ──────────
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }
  D.markdown = function markdown(src) {
    const lines = D.esc(src).split('\n');
    const out = [];
    let i = 0; let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flush();
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
        continue;
      }
      if (/^\s*$/.test(line)) { flush(); i++; continue; }
      const hd = line.match(/^(#{1,6})\s+(.*)/);
      if (hd) { flush(); out.push(`<h${Math.min(hd[1].length + 2, 5)}>${inline(hd[2])}</h${Math.min(hd[1].length + 2, 5)}>`); i++; continue; }
      if (/^(-{3,}|\*{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^&gt;\s?/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
        out.push(`<blockquote>${inline(buf.join('<br>'))}</blockquote>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
        flush();
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = row(line); i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const li = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)/);
      if (li) {
        flush();
        const ordered = /\d/.test(li[1]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*([-*•]|\d+[.)])\s+(.*)/);
          if (!m || /\d/.test(m[1]) !== ordered) break;
          items.push(`<li>${inline(m[2].replace(/^\[[ x]\]\s*/, ''))}</li>`);
          i++;
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }
      para.push(line); i++;
    }
    flush();
    return out.join('');
  };

  // ── 날짜 ─────────────────────────────────────
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  D.fmtTime = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  D.fmtShort = (ts) => {
    const d = new Date(ts); const now = new Date();
    if (sameDay(d, now)) return D.fmtTime(ts);
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return '어제';
    return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  };
  D.dayGroup = (ts) => {
    const d = new Date(ts); const now = new Date();
    const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (days <= 0) return '오늘';
    if (days === 1) return '어제';
    if (days < 7) return '지난 7일';
    if (days < 30) return '지난 30일';
    return '이전';
  };
  D.today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  D.dueInfo = (due) => {
    if (!due) return { text: '', cls: '' };
    const days = Math.round((new Date(`${due}T00:00`) - new Date(`${D.today()}T00:00`)) / 864e5);
    if (days < 0) return { text: `${-days}일 지남`, cls: 'over' };
    if (days === 0) return { text: '오늘까지', cls: 'soon' };
    if (days <= 3) return { text: `D-${days}`, cls: 'soon' };
    return { text: `${due.slice(5).replace('-', '/')} · D-${days}`, cls: '' };
  };

  // 아이콘 (선 굵기 1.7, currentColor)
  // createElement('svg')는 HTML 요소가 되어 그려지지 않으므로, template 으로 SVG 네임스페이스에서 파싱한다.
  const icon = (d, size = 20) => {
    const t = document.createElement('template');
    t.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${d}</svg>`;
    return t.content.firstChild;
  };
  D.icon = {
    plus: (s) => icon('<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', s),
    menu: (s) => icon('<path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', s),
    chat: (s) => icon('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V16a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>', s),
    team: (s) => icon('<circle cx="9" cy="8.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 19c.8-3 3.2-4.6 6-4.6s5.2 1.6 6 4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="17" cy="9.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M17.6 14.4c1.9.3 3.1 1.6 3.5 3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>', s),
    memory: (s) => icon('<path d="M6 4h12v16l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>', s),
    chart: (s) => icon('<path d="M5 19V11M12 19V5M19 19v-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', s),
    gear: (s) => icon('<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 3v2.4M12 18.6V21M21 12h-2.4M5.4 12H3M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3 5.6 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>', s),
    clip: (s) => icon('<path d="M20 11.5 12.3 19.2a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>', s),
    up: (s) => icon('<path d="M12 19V6M6 11.5 12 5.5l6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>', s),
    stop: (s) => icon('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>', s),
    copy: (s) => icon('<rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V6a1 1 0 0 1 1-1h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', s),
    reply: (s) => icon('<path d="M10 8 5 12.5l5 4.5M5.5 12.5H14a5 5 0 0 1 5 5V19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>', s),
    chevron: (s) => icon('<path d="m8 10 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', s),
    spark: (s) => icon('<path d="M12 3.5c.4 3.9 2.6 6.1 6.5 6.5-3.9.4-6.1 2.6-6.5 6.5-.4-3.9-2.6-6.1-6.5-6.5 3.9-.4 6.1-2.6 6.5-6.5zM18.5 15.5c.2 1.6 1 2.4 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.1 2.3-.9 2.5-2.5z" fill="currentColor"/>', s),
  };
})();
