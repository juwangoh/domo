'use strict';
// 크리틱 리허설 화면: 시작 시트(용도·단계·장표) → 읽기 확인 카드 → 리포트(지적 카드·판정·실제 결과)
(() => {
  const { h, S, api, safe } = D;
  const pad = (n) => String(n).padStart(2, '0');
  // textarea 는 속성이 아니라 값으로 채워야 한다.
  const ta = (attrs, value = '') => { const el = h('textarea', attrs); el.value = value; return el; };
  const put = (el, ...kids) => { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };

  // 크리틱 기록은 서버에서 읽어 온다 (대화에는 요약 글만 남는다).
  const cache = new Map();
  async function load(id, fresh) {
    if (fresh || !cache.has(id)) cache.set(id, api('GET', `/api/critiques/${encodeURIComponent(id)}`).then((r) => r.critique).catch(() => null));
    return cache.get(id);
  }
  // 새 메시지가 오면 해당 크리틱 카드를 다시 그린다 (확인 카드가 잠기고, 리포트가 붙는다).
  D.critiqueOnMessage = (msg) => {
    const id = msg.meta?.critiqueConfirm || (msg.meta?.kind === 'critique-report' && msg.meta.critiqueId);
    if (!id) return false;
    cache.delete(id);
    return true;
  };

  // ── 시작 시트 ────────────────────────────────
  D.critiqueSheet = (preset = '') => {
    const K = S.me.critique;
    const opt = { purpose: 'class', stage: 'final', course: '', brief: '', field: '', medium: '' };
    let slides = [];
    let busy = false;
    D.openSheet({ title: '크리틱 리허설', wide: true }, (body) => {
      const note = h('p', { class: 'sheet-note' });
      const drawNote = () => {
        const P = K.purposes[opt.purpose];
        note.textContent = `${P.lenses.join(' · ')}이 봅니다. 비중: ${K.criteria.map((c) => `${c.label} ${P.weights[c.id]}%`).join(' · ')}${K.stages[opt.stage].scores ? '' : ' · 아이디어 단계는 점수를 매기지 않아요'}`;
      };
      const grid = h('div', { class: 'slide-grid' });
      const status = h('div', { class: 'crit-status', role: 'status' });
      const picker = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true, onchange: async (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (!files.length) return;
        status.textContent = '장표를 읽는 중…';
        try {
          const added = await D.slides.fromFiles(files, (t) => { status.textContent = t; });
          slides = [...slides, ...added].slice(0, D.slides.MAX);
          status.textContent = slides.length >= D.slides.MAX ? `장표는 ${D.slides.MAX}장까지 넣을 수 있어요.` : '';
        } catch (err) { status.textContent = err.message || '파일을 읽지 못했어요.'; }
        drawGrid();
      } });
      const drawGrid = () => {
        grid.replaceChildren(
          ...slides.map((s, i) => h('figure', { class: 'slide-thumb' },
            h('img', { src: s.thumb, alt: `${pad(i + 1)}번 장표` }), h('figcaption', {}, `${pad(i + 1)}번`),
            h('button', { class: 'slide-x', type: 'button', 'aria-label': `${pad(i + 1)}번 장표 빼기`, onclick: () => { slides.splice(i, 1); drawGrid(); } }, '×'))),
          h('button', { class: 'slide-add', type: 'button', onclick: () => picker.click() }, D.icon.plus(20), h('span', {}, slides.length ? '더 넣기' : '판넬·장표 넣기'), h('small', {}, '이미지 또는 PDF')));
      };
      const desc = ta({ class: 'auth-input area', rows: 3, placeholder: '어떤 과제인지, 무엇을 봐 주면 좋을지 적어 주세요. (선택)' }, preset);
      const text = (key, placeholder, max) => h('input', { class: 'auth-input', type: 'text', maxlength: max, placeholder, oninput: (e) => { opt[key] = e.target.value; } });
      const go = h('button', { class: 'btn-primary', type: 'button', onclick: async () => {
        if (busy) return;
        if (!slides.length && !desc.value.trim()) { status.textContent = '장표를 넣거나 설명을 적어 주세요.'; return; }
        busy = true;
        go.disabled = true;
        try {
          const roomId = await D.uploadRoom();
          const sent = [];
          for (const [i, s] of slides.entries()) {
            status.textContent = `장표 올리는 중 ${i + 1}/${slides.length}`;
            const up = (payload, name) => api('POST', `/api/rooms/${encodeURIComponent(roomId)}/upload`, { name, ...payload }).then((r) => r.file);
            const view = await up(s.view(), `${pad(i + 1)}번 ${s.name}`.slice(0, 80));
            const ai = await up(s.ai(i + 1), `${pad(i + 1)}번 좌표축`);
            sent.push({ fileId: view.id, aiFileId: ai.id, name: s.name, width: s.width, height: s.height });
          }
          const line = `/크리틱 용도:${K.purposes[opt.purpose].label} 단계:${K.stages[opt.stage].label}${desc.value.trim() ? ` ${desc.value.trim()}` : ''}`;
          D.closeSheet();
          await D.sendWith(line, { files: sent.slice(0, 8).map((x) => x.fileId), critique: { ...opt, slides: sent } });
        } catch (err) {
          if (err.message !== 'login') status.textContent = err.message || '올리지 못했어요. 다시 시도해 주세요.';
          busy = false;
          go.disabled = false;
        }
      } }, '읽기 확인 시작');
      const plan = S.me.team.plan?.critique;
      put(body,
        h('div', { class: 'sheet-label' }, '용도'),
        D.segmented(Object.entries(K.purposes).map(([k, p]) => [k, p.label]), opt.purpose, (v) => { opt.purpose = v; drawNote(); }),
        h('div', { class: 'sheet-label' }, '진행 단계'),
        D.segmented(Object.entries(K.stages).map(([k, s]) => [k, s.label]), opt.stage, (v) => { opt.stage = v; drawNote(); }),
        note,
        h('div', { class: 'sheet-label' }, '장표'), grid, picker,
        h('div', { class: 'sheet-label' }, '설명'), desc,
        h('details', { class: 'crit-more' }, h('summary', {}, '수업·과제 정보 더 적기 (선택)'),
          h('div', { class: 'crit-more-grid' },
            D.field('수업명', text('course', '예) 제품디자인 스튜디오', 80)),
            D.field('분야', text('field', '예) 제품, 건축, UX, 패션', 40)),
            D.field('매체', text('medium', '예) 판넬, PT, 렌더', 40)),
            D.field('과제 지침', h('textarea', { class: 'auth-input area', rows: 3, maxlength: 2000, placeholder: '교수님이 준 과제 조건이나 평가 기준', oninput: (e) => { opt.brief = e.target.value; } })))),
        status,
        h('div', { class: 'crit-go' },
          h('span', { class: 'crit-go-note' }, plan ? `먼저 AI가 결과물을 어떻게 읽었는지 보여 드려요 · 전체 호출 ${plan.calls}회` : '먼저 AI가 결과물을 어떻게 읽었는지 보여 드려요'),
          go));
      drawNote();
      drawGrid();
    });
  };

  // ── 읽기 확인 카드 ───────────────────────────
  D.critiqueReadCard = (m) => {
    const card = h('div', { class: 'card crit-read' }, h('b', {}, '읽기 확인'), h('p', {}, '불러오는 중…'));
    load(m.meta.critiqueId).then((C) => {
      if (!C?.read) { card.replaceChildren(h('b', {}, '읽기 확인'), h('p', {}, '기록을 찾을 수 없습니다.')); return; }
      const live = C.status === 'confirm';
      const r = C.read.final || C.read.ai;
      if (!live) {
        card.replaceChildren(
          h('b', {}, '읽기 확인'),
          h('dl', { class: 'crit-dl' },
            h('dt', {}, '컨셉'), h('dd', {}, r.concept || '-'), h('dt', {}, '사이트·맥락'), h('dd', {}, r.context || '-'), h('dt', {}, '타깃'), h('dd', {}, r.target || '-')),
          C.read.confirmedFacts?.length ? h('p', {}, `직접 확인한 사실: ${C.read.confirmedFacts.join(' / ')}`) : null,
          h('span', { class: 'tag' }, C.status === 'cancelled' ? '닫음' : C.read.edited ? '고쳐서 확인함' : '확인함'));
        return;
      }
      card.classList.add('live');
      const v = { concept: r.concept, context: r.context, target: r.target, slides: r.slides.map((s) => ({ ...s })), facts: r.facts.join('\n'), assumptions: r.assumptions.join('\n'), confirmed: '' };
      const line = (key, label) => D.field(label, h('input', { class: 'auth-input', type: 'text', value: v[key], maxlength: 400, oninput: (e) => { v[key] = e.target.value; } }));
      const area = (key, label, placeholder, rows = 3) => D.field(label, ta({ class: 'auth-input area', rows, placeholder, oninput: (e) => { v[key] = e.target.value; } }, v[key]));
      const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
      const go = h('button', { class: 'btn-primary small', type: 'button', onclick: async () => {
        go.disabled = true;
        const ok = await safe(api('POST', `/api/critiques/${C.id}/confirm`, {
          read: { concept: v.concept, context: v.context, target: v.target, slides: v.slides, facts: lines(v.facts), assumptions: lines(v.assumptions) },
          confirmedFacts: v.confirmed,
        }));
        if (!ok) go.disabled = false;
      } }, '이대로 크리틱 시작');
      card.replaceChildren(...[
        h('b', {}, '● 읽기 확인 · 제가 이렇게 이해했어요'),
        h('p', {}, m.text),
        r.raw ? h('p', { class: 'crit-warn' }, '이해한 내용을 형식대로 정리하지 못했어요. 아래 칸에 직접 적어 주세요.') : null,
        line('concept', '컨셉 한 문장'), line('context', '사이트·맥락'), line('target', '타깃 사용자'),
        v.slides.length ? h('div', { class: 'crit-slides' }, h('span', { class: 'field-label' }, '장표와 역할'),
          v.slides.map((s) => {
            const file = C.slides.find((x) => x.n === s.n);
            return h('label', { class: 'crit-slide-row' },
              file?.url && file.image !== false ? h('img', { src: file.url, alt: '', loading: 'lazy' }) : h('span', { class: 'crit-slide-ph' }),
              h('span', { class: 'crit-slide-n' }, `${pad(s.n)}번`),
              h('input', { class: 'auth-input', type: 'text', value: s.role, maxlength: 200, 'aria-label': `${pad(s.n)}번 장표의 역할`, oninput: (e) => { s.role = e.target.value; } }));
          })) : null,
        area('facts', '확인된 사실로 보이는 것 (한 줄에 하나)', ''),
        area('assumptions', '가정으로 보이는 것 (한 줄에 하나)', ''),
        area('confirmed', '내가 직접 확인한 사실', '예) 화장실 위치는 현장 답사로 확인함\n여기에 적은 내용은 모든 시점이 확인된 사실로 봅니다.', 2),
        h('div', { class: 'card-actions' }, go, h('button', { class: 'btn-ghost small', type: 'button', onclick: () => D.sendText('/취소') }, '크리틱 닫기')),
      ].filter(Boolean));
    });
    return card;
  };

  // ── 리포트 ───────────────────────────────────
  const SEV = { 높음: 'revise', 중간: '', 낮음: '' };
  function slideFigure(C, loc) {
    const s = C.slides.find((x) => x.n === loc?.slide);
    if (!s?.url || s.image === false) return null;
    const box = loc.x && loc.y ? h('i', { class: 'crit-box', style: `left:${loc.x[0]}%;top:${loc.y[0]}%;width:${Math.max(4, loc.x[1] - loc.x[0])}%;height:${Math.max(4, loc.y[1] - loc.y[0])}%` }) : null;
    return h('a', { class: 'crit-fig', href: s.url, target: '_blank', rel: 'noopener', title: '원본 크게 보기' }, h('span', { class: 'crit-fig-in' }, h('img', { src: s.url, alt: `${pad(s.n)}번 장표`, loading: 'lazy' }), box));
  }

  function verdictRow(C, x) {
    const row = h('div', { class: 'crit-verdict' });
    const draw = (editing) => {
      if (x.user_verdict !== '미판정' && !editing) {
        row.replaceChildren(
          h('span', { class: `tag ${x.user_verdict === '맞음' ? 'pass' : x.user_verdict === '오판' ? 'revise' : ''}` }, `내 판정 · ${x.user_verdict}`),
          h('span', { class: 'crit-reason' }, x.user_reason),
          h('button', { class: 'link-btn', type: 'button', onclick: () => draw(true) }, '고치기'));
        return;
      }
      let pick = editing ? x.user_verdict : null;
      const why = h('input', { class: 'auth-input', type: 'text', maxlength: 300, placeholder: '이유 한 줄 (적어야 저장돼요)', value: editing ? x.user_reason : '', 'aria-label': '판정 이유' });
      const save = h('button', { class: 'btn-secondary small', type: 'button', disabled: true, onclick: async () => {
        const r = await safe(api('POST', `/api/critiques/${C.id}/issues/${x.id}/verdict`, { verdict: pick, reason: why.value }));
        if (r) { Object.assign(x, r.issue); draw(false); }
      } }, '저장');
      const sync = () => { save.disabled = !pick || !why.value.trim(); };
      why.addEventListener('input', sync);
      const form = h('div', { class: 'crit-verdict-form', hidden: !pick }, why, save);
      const btns = h('div', { class: 'crit-verdict-btns' }, h('span', { class: 'crit-verdict-q' }, '이 지적, 맞나요?'),
        ['맞음', '오판', '애매'].map((vv) => h('button', { class: `chip-btn${pick === vv ? ' on' : ''}`, type: 'button', 'aria-pressed': String(pick === vv), onclick: (e) => {
          pick = vv;
          for (const b of btns.querySelectorAll('.chip-btn')) { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); }
          form.hidden = false;
          sync();
          why.focus();
        } }, vv)));
      row.replaceChildren(btns, form);
      sync();
    };
    draw(false);
    return row;
  }

  function issueCard(C, x) {
    const loc = x.location || {};
    const where = loc.slide ? `${pad(loc.slide)}번${loc.region && loc.region !== '전체' ? ` · ${loc.region}` : ''}${loc.target ? ` · ${loc.target}` : ''}` : loc.hint || '';
    return h('article', { class: 'crit-issue' },
      h('div', { class: 'crit-issue-head' },
        h('span', { class: 'tag' }, x.viewpoint), h('span', { class: 'tag' }, x.criterion),
        h('span', { class: `tag ${x.evidence_type === '추정' ? 'revise' : 'pass'}` }, x.evidence_type),
        h('span', { class: `tag ${SEV[x.severity] || ''}` }, `심각도 ${x.severity}`),
        where ? h('span', { class: 'crit-where' }, where) : null),
      h('div', { class: 'crit-issue-body' },
        h('div', { class: 'crit-issue-text' },
          h('dl', { class: 'crit-dl' },
            h('dt', {}, '기대 기준'), h('dd', {}, x.standard || '-'),
            h('dt', {}, '격차'), h('dd', {}, x.gap || '-'),
            h('dt', {}, '개선 방향'), h('dd', {}, h('ul', { class: 'crit-fixes' }, x.fixes.map((f) => h('li', {}, h('b', {}, f.type), h('span', {}, f.text))))))),
        slideFigure(C, loc)),
      verdictRow(C, x));
  }

  function scoreBlock(C) {
    const t = C.table;
    if (!t || t.total === null) return h('p', { class: 'crit-dim' }, '아이디어 단계라 점수는 매기지 않았어요. 질문과 다른 해석을 중심으로 봐 주세요.');
    return h('div', { class: 'crit-score' },
      h('div', { class: 'crit-total' }, h('b', {}, t.total.toFixed(2)), h('span', {}, '/ 5 · 가중 평균')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '항목 (비중)'), t.lenses.map((l) => h('th', {}, l.replace(' 시점', ''))), h('th', {}, '평균'))),
        h('tbody', {}, t.rows.map((r) => h('tr', {}, h('td', {}, `${r.criterion} (${r.weight}%)`), r.scores.map((s) => h('td', {}, s ?? '-')), h('td', {}, h('b', {}, r.avg ?? '-'))))))));
  }

  function outcomeBlock(C) {
    const wrap = h('details', { class: 'crit-outcome', open: !!C.outcome });
    const draw = () => {
      const fb = ta({ class: 'auth-input area', rows: 3, maxlength: 4000, placeholder: '교수님이 실제로 한 피드백을 생각나는 대로 적어 주세요.' }, C.outcome?.feedback || '');
      const score = h('input', { class: 'auth-input', type: 'text', maxlength: 40, placeholder: '받은 점수 (예: A-, 87)', value: C.outcome?.score || '', 'aria-label': '받은 점수' });
      wrap.replaceChildren(
        h('summary', {}, C.outcome ? '실제 결과 · 입력함' : '크리틱이 끝났나요? 실제 결과 입력 (30초)'),
        h('p', { class: 'sheet-note' }, 'DOMO의 예측과 실제 피드백을 나중에 비교하는 데 씁니다.'),
        fb, h('div', { class: 'inline-form' }, score, h('button', { class: 'btn-secondary small', type: 'button', onclick: async () => {
          const r = await safe(api('POST', `/api/critiques/${C.id}/outcome`, { feedback: fb.value, score: score.value }));
          if (r) { C.outcome = r.outcome; D.toast('저장했어요'); draw(); }
        } }, '저장')));
    };
    draw();
    return wrap;
  }

  D.critiqueReport = (body, m) => {
    body.classList.add('report', 'crit-report');
    body.innerHTML = D.markdown(m.text.split('\n').slice(0, 2).join('\n'));
    load(m.meta.critiqueId).then((C) => {
      if (!C) { body.innerHTML = D.markdown(m.text); return; }
      const K = S.me.critique;
      const bad = C.checks.filter((c) => c.result !== '통과');
      const section = (title, ...kids) => h('section', { class: 'crit-sec' }, h('h3', {}, title), kids);
      const judged = C.issues.filter((x) => x.user_verdict !== '미판정').length;
      body.replaceChildren(...[
        h('div', { class: 'crit-head' },
          h('span', { class: 'tag' }, K.purposes[C.purpose]?.label || C.purpose), h('span', { class: 'tag' }, `${K.stages[C.stage]?.label || C.stage} 단계`),
          C.slides.length ? h('span', { class: 'tag' }, `장표 ${C.slides.length}장`) : null),
        C.synth?.summary ? h('p', { class: 'crit-summary' }, C.synth.summary) : null,
        scoreBlock(C),
        C.synth?.top3?.length ? section(`고칠 점 Top ${C.synth.top3.length}`, h('ol', { class: 'crit-top' }, C.synth.top3.map((t) => h('li', {}, h('b', {}, t.title), t.why ? h('span', {}, t.why) : null)))) : null,
        C.issues.length ? section(`시점별 지적 ${C.issues.length}개`,
          h('p', { class: 'crit-dim' }, `지적마다 맞는지 판정해 주세요. 판정이 쌓이면 DOMO의 크리틱이 나아집니다.${judged ? ` (${judged}/${C.issues.length} 판정함)` : ''}`),
          C.issues.map((x) => issueCard(C, x))) : null,
        C.checks.length || C.checkSkipped ? section('검증',
          C.checkSkipped ? h('p', { class: 'crit-warn' }, '검증 호출이 실패해 숫자·일관성 확인은 건너뛰었습니다.') : null,
          bad.length ? h('ul', { class: 'crit-checks' }, bad.map((c) => h('li', {}, h('span', { class: `tag ${c.result === '문제' ? 'revise' : ''}` }, c.result), h('b', {}, c.item), h('span', {}, `${c.note}${c.slide ? ` · ${pad(c.slide)}번` : ''}`))))
            : C.checks.length ? h('p', { class: 'crit-dim' }, `확인한 ${C.checks.length}개 항목에서 문제를 찾지 못했어요.`) : null,
          bad.length && C.checks.length > bad.length ? h('p', { class: 'crit-dim' }, `그 밖의 ${C.checks.length - bad.length}개 항목은 통과했어요.`) : null) : null,
        C.questions.length || C.synth?.qa?.length ? section('예상 질문과 답변 준비',
          C.synth?.qa?.length ? h('ul', { class: 'crit-qa' }, C.synth.qa.map((x) => h('li', {}, h('b', {}, x.q), h('span', {}, x.a)))) : null,
          C.questions.length ? h('details', { class: 'crit-more' }, h('summary', {}, `시점별 질문 ${C.questions.length}개 모두 보기`),
            h('ul', {}, C.questions.map((q) => h('li', {}, `(${q.viewpoint}) ${q.text}`)))) : null) : null,
        ...C.raw.map((l) => section(`${l.label} (형식을 읽지 못해 원문 그대로)`, h('div', { html: D.markdown(l.text) }))),
        outcomeBlock(C),
        h('p', { class: 'crit-cost' }, `AI 호출 ${C.totals.calls}회 · ${(C.totals.ms / 1000).toFixed(0)}초${C.totals.costUsd ? ` · $${C.totals.costUsd.toFixed(2)}` : ''}${C.totals.tokensIn ? ` · 토큰 ${(C.totals.tokensIn + C.totals.tokensOut).toLocaleString()}` : ''}`),
      ].filter(Boolean));
    });
  };
})();
