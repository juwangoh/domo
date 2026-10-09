'use strict';
// 반복 작업 → 자동 스킬.
// 대화가 끝날 때마다 기억 정리 AI가 "이 대화가 다시 쓸 만한 반복 작업인지"를 알려준다(pattern).
// 같은 작업이 ACTIVATE_AT 번 나오면 Claude Code 스킬 파일(workspace/.claude/skills/domo-*/SKILL.md)로 등록한다.
// Claude Code 는 작업 폴더의 스킬을 스스로 찾아 쓰고, Codex 에는 시스템 프롬프트로 요약을 넣는다.
//
// 너무 많이 쌓이지 않게 하는 장치
//  · 비슷한 작업은 하나로 합친다 (이름·키 단어가 60% 이상 겹치면 같은 작업)
//  · 활성 스킬은 최대 MAX_ACTIVE 개. 넘치면 가장 오래 안 쓴 것(고정 제외)을 보관함으로 옮긴다
//  · ARCHIVE_DAYS 일 동안 안 쓴 활성 스킬은 자동으로 보관함으로 옮긴다
//  · 후보(아직 3번이 안 된 것)는 최대 MAX_CANDIDATES 개, 오래되고 적게 나온 것부터 지운다
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ACTIVATE_AT = 3;
const MAX_ACTIVE = 8;
const MAX_CANDIDATES = 30;
const ARCHIVE_DAYS = 45;
const DAY = 864e5;

const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
function similarity(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size);
}
const slugify = (s) => {
  const ascii = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return ascii.length >= 3 ? ascii.slice(0, 40) : `skill-${crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8)}`;
};

class Skills {
  constructor(dataDir, workspace, { now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'skills.json');
    this.dir = path.join(workspace, '.claude', 'skills');
    this.now = now;
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.items = []; }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1));
    fs.renameSync(tmp, this.file);
  }

  list() { return this.items; }
  active() { return this.items.filter((x) => x.status === 'active'); }

  find(p) {
    let best = null;
    let score = 0;
    for (const x of this.items) {
      if (x.status === 'deleted') continue;
      const s = Math.max(similarity(x.key, p.key), similarity(x.name, p.name || p.key));
      if (s > score) { score = s; best = x; }
    }
    return score >= 0.6 ? best : null;
  }

  // 반복 작업 하나를 관찰한다. 결과: { item, activated: bool, archived: [이름...] }
  observe(p, { source = '' } = {}) {
    if (!p || !p.key || !p.name) return null;
    const pattern = {
      key: String(p.key).slice(0, 60),
      name: String(p.name).slice(0, 40),
      description: String(p.description || '').slice(0, 200),
      steps: (Array.isArray(p.steps) ? p.steps : []).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 8),
    };
    const now = this.now();
    let item = this.find(pattern);
    let activated = false;
    if (item) {
      item.count++;
      item.lastSeen = now;
      if (item.status === 'active') { item.uses = (item.uses || 0) + 1; item.lastUsed = now; }
      // 내용은 최신 대화 기준으로 다듬되, 사용자가 고친 스킬은 덮어쓰지 않는다.
      if (!item.edited) {
        if (pattern.description) item.description = pattern.description;
        if (pattern.steps.length) item.steps = pattern.steps;
      }
      if (source && !item.sources.includes(source)) item.sources = [...item.sources, source].slice(-5);
      if (item.status === 'archived' && item.count >= ACTIVATE_AT) { item.status = 'candidate'; }
    } else {
      item = {
        id: crypto.randomUUID().slice(0, 8), slug: slugify(pattern.key), ...pattern,
        count: 1, uses: 0, status: 'candidate', pinned: false, edited: false,
        createdAt: now, lastSeen: now, lastUsed: null, sources: source ? [source] : [],
      };
      if (this.items.some((x) => x.slug === item.slug)) item.slug = `${item.slug}-${item.id.slice(0, 4)}`;
      this.items.push(item);
    }
    if (item.status === 'candidate' && item.count >= ACTIVATE_AT) {
      item.status = 'active';
      item.activatedAt = now;
      item.lastUsed = now;
      activated = true;
    }
    const archived = this.prune();
    this.writeFiles();
    this.save();
    return { item, activated, archived };
  }

  // 정리: 오래 안 쓴 활성 스킬 보관, 활성 개수 제한, 후보 개수 제한
  prune() {
    const now = this.now();
    const archived = [];
    const archive = (x, why) => { x.status = 'archived'; x.archivedAt = now; x.archivedWhy = why; archived.push(x.name); };
    for (const x of this.active()) {
      if (!x.pinned && now - (x.lastUsed || x.activatedAt || x.createdAt) > ARCHIVE_DAYS * DAY) archive(x, `${ARCHIVE_DAYS}일 동안 쓰지 않음`);
    }
    const act = this.active().filter((x) => !x.pinned).sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    let over = this.active().length - MAX_ACTIVE;
    while (over-- > 0 && act.length) archive(act.shift(), `활성 스킬이 ${MAX_ACTIVE}개를 넘어서 가장 오래 안 쓴 것을 보관`);
    const cands = this.items.filter((x) => x.status === 'candidate').sort((a, b) => a.count - b.count || a.lastSeen - b.lastSeen);
    let extra = cands.length - MAX_CANDIDATES;
    const drop = new Set();
    while (extra-- > 0 && cands.length) drop.add(cands.shift().id);
    if (drop.size) this.items = this.items.filter((x) => !drop.has(x.id));
    return archived;
  }

  update(id, patch) {
    const x = this.items.find((i) => i.id === id);
    if (!x) return null;
    if (typeof patch.pinned === 'boolean') x.pinned = patch.pinned;
    if (patch.status === 'active' && x.status !== 'active') { x.status = 'active'; x.activatedAt = this.now(); x.lastUsed = this.now(); }
    if (patch.status === 'archived' && x.status !== 'archived') { x.status = 'archived'; x.archivedAt = this.now(); x.archivedWhy = '직접 보관'; }
    if (typeof patch.name === 'string' && patch.name.trim()) { x.name = patch.name.trim().slice(0, 40); x.edited = true; }
    if (typeof patch.description === 'string') { x.description = patch.description.slice(0, 200); x.edited = true; }
    if (Array.isArray(patch.steps)) { x.steps = patch.steps.map(String).filter(Boolean).slice(0, 8); x.edited = true; }
    this.prune();
    this.writeFiles();
    this.save();
    return x;
  }

  remove(id) {
    this.items = this.items.filter((x) => x.id !== id);
    this.writeFiles();
    this.save();
  }

  // 활성 스킬만 SKILL.md 로 둔다. DOMO 가 만든 폴더(domo-*)만 관리하고 다른 스킬은 건드리지 않는다.
  writeFiles() {
    fs.mkdirSync(this.dir, { recursive: true });
    const want = new Set(this.active().map((x) => `domo-${x.slug}`));
    for (const d of fs.readdirSync(this.dir)) {
      if (d.startsWith('domo-') && !want.has(d)) fs.rmSync(path.join(this.dir, d), { recursive: true, force: true });
    }
    for (const x of this.active()) {
      const folder = path.join(this.dir, `domo-${x.slug}`);
      fs.mkdirSync(folder, { recursive: true });
      const desc = `${x.description || x.name} 사용자가 "${x.key}" 같은 요청을 하면 이 절차를 따른다.`.replace(/\n/g, ' ');
      fs.writeFileSync(path.join(folder, 'SKILL.md'), `---
name: domo-${x.slug}
description: ${JSON.stringify(desc)}
---

# ${x.name}

DOMO 가 반복 작업에서 자동으로 만든 스킬입니다. (${x.count}번 나온 작업 · 출처: ${x.sources.join(', ') || '대화'})

## 언제 쓰나
${x.description || x.key}

## 절차
${(x.steps.length ? x.steps : ['사용자의 요청을 확인하고, 지난번과 같은 형식으로 결과를 낸다.']).map((s, i) => `${i + 1}. ${s}`).join('\n')}
`);
    }
  }

  // Codex 등 스킬 파일을 직접 읽지 않는 엔진을 위한 요약
  promptText() {
    const a = this.active();
    if (!a.length) return '';
    return `[자동 스킬 — 사용자가 반복하는 작업과 정해진 절차]\n${a.map((x) => `- ${x.name}: ${x.description || x.key}${x.steps.length ? ` (절차: ${x.steps.join(' → ')})` : ''}`).join('\n')}`;
  }
}

module.exports = { Skills, similarity, ACTIVATE_AT, MAX_ACTIVE, ARCHIVE_DAYS, MAX_CANDIDATES };
