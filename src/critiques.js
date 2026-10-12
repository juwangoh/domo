'use strict';
// 크리틱 기록 저장 계층. 지금은 내 컴퓨터 파일에 저장하고, 나중에 Supabase 같은 DB 로 옮길 수 있게
// 저장소(어댑터)를 따로 둔다. 어댑터는 list/get/put 세 가지만 구현하면 된다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class LocalAdapter {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) { return path.join(this.dir, `${id}.json`); }

  list() {
    return fs.readdirSync(this.dir).filter((f) => /^[a-z0-9]+\.json$/.test(f)).map((f) => this.get(f.slice(0, -5))).filter(Boolean);
  }

  get(id) {
    if (!/^[a-z0-9]+$/.test(String(id))) return null;
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }

  put(record) {
    const tmp = `${this.file(record.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 1));
    fs.renameSync(tmp, this.file(record.id));
  }
}

const EXAMPLE_MIN = 30; // "맞음" 판정이 이만큼 쌓이기 전에는 예시 은행을 쓰지 않는다
const TAG_KEYS = ['field', 'medium', 'purpose', 'stage', 'taskType'];

class CritiqueStore {
  constructor(adapter) {
    this.db = adapter;
  }

  // 이름·학교·교수명처럼 사람을 가리키는 정보는 private 에 따로 둔다. 본문 데이터를 내보낼 때 private 은 빼면 된다.
  create({ roomId, purpose, stage, request, input = {}, slides = [], principles = '', consent = false, person = {} }) {
    const record = {
      id: crypto.randomBytes(5).toString('hex'), roomId, createdAt: Date.now(), status: 'reading',
      purpose, stage, request: String(request || '').slice(0, 4000), principles,
      input: {
        course: String(input.course || '').slice(0, 80), brief: String(input.brief || '').slice(0, 2000),
        field: String(input.field || '').slice(0, 40), medium: String(input.medium || '').slice(0, 40), taskType: String(input.taskType || '').slice(0, 40),
      },
      slides, // [{ n, fileId, path, axis, width, height, name }]
      read: null, // { ai, final, confirmedFacts, edited }
      lenses: [], issues: [], questions: [], checks: [], table: null, synth: null, raw: [],
      outcome: null, // 실제 결과: { feedback, score, at }
      revision: null, // 수정본 (선택)
      calls: [], totals: { calls: 0, ms: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
      consent: !!consent,
      private: { name: String(person.name || ''), school: String(person.school || ''), professor: String(person.professor || '') },
    };
    this.db.put(record);
    return record;
  }

  get(id) { return this.db.get(id); }

  update(id, patch) {
    const r = this.db.get(id);
    if (!r) return null;
    Object.assign(r, typeof patch === 'function' ? patch(r) || {} : patch);
    this.db.put(r);
    return r;
  }

  list() {
    return this.db.list().sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ id: r.id, roomId: r.roomId, createdAt: r.createdAt, status: r.status, purpose: r.purpose, stage: r.stage, request: r.request.slice(0, 80), total: r.table?.total ?? null, issues: r.issues.length, judged: r.issues.filter((x) => x.user_verdict !== '미판정').length, outcome: !!r.outcome, totals: r.totals }));
  }

  // 호출 1회의 비용 기록 (이후 가격 산정용)
  logCall(id, call) {
    return this.update(id, (r) => {
      r.calls.push({ at: Date.now(), ...call });
      const sum = (k) => r.calls.reduce((a, c) => a + (Number(c[k]) || 0), 0);
      r.totals = { calls: r.calls.length, ms: sum('ms'), costUsd: Math.round(sum('costUsd') * 10000) / 10000, tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut') };
    });
  }

  // 판정은 이유를 적어야 저장된다.
  setVerdict(id, issueId, verdict, reason) {
    const text = String(reason || '').trim().slice(0, 300);
    if (!['맞음', '오판', '애매'].includes(verdict)) return { error: '판정을 골라 주세요.', status: 400 };
    if (!text) return { error: '판정 이유를 한 줄 적어 주세요.', status: 400 };
    let found = null;
    const r = this.update(id, (rec) => {
      found = rec.issues.find((x) => x.id === issueId);
      if (found) Object.assign(found, { user_verdict: verdict, user_reason: text, judgedAt: Date.now() });
    });
    if (!r || !found) return { error: '지적을 찾을 수 없습니다.', status: 404 };
    return { issue: found };
  }

  setOutcome(id, { feedback, score }) {
    const text = String(feedback || '').trim().slice(0, 4000);
    if (!text && !String(score || '').trim()) return { error: '실제 피드백이나 점수를 적어 주세요.', status: 400 };
    const r = this.update(id, { outcome: { feedback: text, score: String(score || '').trim().slice(0, 40), at: Date.now() } });
    return r ? { outcome: r.outcome } : { error: '크리틱을 찾을 수 없습니다.', status: 404 };
  }
}

// 예시 은행: 사용자가 "맞음"으로 판정한 지적만, 활용에 동의한 기록에서만 뽑는다.
// 지금은 태그가 많이 겹치는 순으로 고른다. 나중에 이미지 유사도 검색으로 바꿀 때는 pick 만 갈아 끼우면 된다.
class ExampleBank {
  constructor(store, { min = EXAMPLE_MIN } = {}) {
    this.store = store;
    this.min = min;
  }

  pool() {
    const out = [];
    for (const r of this.store.db.list()) {
      if (!r.consent) continue;
      const tags = { ...r.input, purpose: r.purpose, stage: r.stage };
      for (const x of r.issues) if (x.user_verdict === '맞음') out.push({ tags, criterion: x.criterion, viewpoint: x.lens, standard: x.standard, gap: x.gap, fixes: x.fixes });
    }
    return out;
  }

  status() {
    const n = this.pool().length;
    return { count: n, min: this.min, active: n >= this.min };
  }

  pick(tags, n = 6) {
    const pool = this.pool();
    if (pool.length < this.min) return [];
    const overlap = (e) => TAG_KEYS.filter((k) => tags[k] && e.tags[k] === tags[k]).length;
    return pool.map((e) => ({ e, s: overlap(e) })).sort((a, b) => b.s - a.s).slice(0, Math.max(4, Math.min(8, n))).map((x) => x.e);
  }
}

module.exports = { CritiqueStore, LocalAdapter, ExampleBank, EXAMPLE_MIN };
