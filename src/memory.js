'use strict';
// 장기 기억: 내 정보 · 기억 노트 · 프로젝트 · 과제 · 대화방 요약.
// Hermes의 USER.md / MEMORY.md 구조를 벤치마킹했고, 모든 AI 프로필이 같은 기억을 공유한다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// principles = 내 기준(디렉터 노트): 사용자의 판단 기준·취향. 모든 AI가 맨 앞에 읽고, 크리틱의 채점 기준이 된다.
const KINDS = ['principles', 'user', 'notes', 'projects', 'tasks'];
const PROJECT_STATUS = ['진행 중', '보류', '완료'];

class Memory {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'memory.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.data = { principles: [], user: [], notes: [], projects: [], tasks: [], roomSummaries: {}, version: 1, ...this.data };
  }

  save() {
    this.data.version++;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  get version() { return this.data.version; }
  all() { return this.data; }

  add(kind, input, { save = true } = {}) {
    if (!KINDS.includes(kind)) throw Object.assign(new Error('알 수 없는 종류'), { status: 400 });
    const item = { id: crypto.randomUUID().slice(0, 8), ts: Date.now(), ...clean(kind, input) };
    if (kind === 'user' || kind === 'notes' || kind === 'principles') {
      if (!item.text) return null;
      if (this.data[kind].some((x) => sameText(x.text, item.text))) return null; // 중복 방지
    }
    if (kind === 'projects') {
      if (!item.name) return null;
      const exist = this.data.projects.find((p) => sameText(p.name, item.name));
      if (exist) return this.update('projects', exist.id, input, { save });
    }
    if (kind === 'tasks') {
      if (!item.title) return null;
      if (this.data.tasks.some((t) => t.status !== 'done' && sameText(t.title, item.title))) return null;
    }
    this.data[kind].push(item);
    if (save) this.save();
    return item;
  }

  update(kind, id, patch, { save = true } = {}) {
    const item = (this.data[kind] || []).find((x) => x.id === id);
    if (!item) return null;
    Object.assign(item, clean(kind, { ...item, ...patch }), { ts: Date.now() });
    if (kind === 'projects' && patch.note) item.notes = [...(item.notes || []), String(patch.note).slice(0, 500)].slice(-20);
    if (save) this.save();
    return item;
  }

  remove(kind, id) {
    this.data[kind] = (this.data[kind] || []).filter((x) => x.id !== id);
    this.save();
  }

  setRoomSummary(roomId, text) {
    if (!text) return;
    this.data.roomSummaries[roomId] = { text: String(text).slice(0, 600), ts: Date.now() };
    this.save();
  }

  deleteRoom(roomId) {
    delete this.data.roomSummaries[roomId];
    this.save();
  }

  findProject(nameOrId) {
    if (!nameOrId) return null;
    return this.data.projects.find((p) => p.id === nameOrId || sameText(p.name, nameOrId)) || null;
  }

  // AI 시스템 프롬프트에 들어가는 기억 요약 (길이 제한)
  context({ roomId, roomNames = {} } = {}) {
    const d = this.data;
    const parts = [];
    if (d.principles.length) parts.push(`[내 기준 — 사용자(디렉터)의 판단 기준. 모든 결과물은 이 기준에 맞아야 함]\n${principleList(d.principles)}`);
    if (d.user.length) parts.push(`[사용자에 대해 알고 있는 것]\n${d.user.map((x) => `- ${x.text}`).join('\n')}`);
    if (d.notes.length) parts.push(`[기억 노트]\n${d.notes.slice(-40).map((x) => `- ${x.text}`).join('\n')}`);
    const active = d.projects.filter((p) => p.status !== '완료');
    if (active.length) {
      parts.push(`[진행 중 프로젝트]\n${active.map((p) => `- ${p.name} (${p.status})${p.desc ? `: ${p.desc}` : ''}${p.notes?.length ? `\n  최근 메모: ${p.notes.slice(-3).join(' / ')}` : ''}`).join('\n')}`);
    }
    const open = d.tasks.filter((t) => t.status !== 'done').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    if (open.length) {
      parts.push(`[열린 과제·할 일]\n${open.slice(0, 30).map((t) => {
        const p = d.projects.find((x) => x.id === t.projectId);
        return `- ${t.title}${t.due ? ` · 기한 ${t.due}` : ''}${p ? ` · ${p.name}` : ''}${t.owner ? ` · 담당 ${t.owner}` : ''}`;
      }).join('\n')}`);
    }
    const others = Object.entries(d.roomSummaries).filter(([id]) => id !== roomId && roomNames[id])
      .sort((a, b) => b[1].ts - a[1].ts).slice(0, 6);
    if (others.length) parts.push(`[다른 대화방 최근 요약]\n${others.map(([id, s]) => `- ${roomNames[id]}: ${s.text}`).join('\n')}`);
    let text = parts.join('\n\n');
    if (text.length > 9000) text = `${text.slice(0, 9000)}\n…(생략)`;
    return text;
  }

  principlesText() { return principleList(this.data.principles); }

  // Hermes 의 ~/.hermes/memories/USER.md, MEMORY.md 를 가져온다 (§ 로 항목 구분)
  importHermes(hermesDir) {
    const read = (f) => { try { return fs.readFileSync(path.join(hermesDir, 'memories', f), 'utf8'); } catch { return ''; } };
    const split = (s) => s.split(/\n?§\n?/).map((x) => x.trim()).filter((x) => x.length > 3);
    let added = 0;
    for (const text of split(read('USER.md'))) if (this.add('user', { text }, { save: false })) added++;
    for (const text of split(read('MEMORY.md'))) if (this.add('notes', { text }, { save: false })) added++;
    this.save();
    return added;
  }
}

function principleList(items) {
  return items.map((x, i) => `${i + 1}. ${x.text}`).join('\n');
}

function clean(kind, x) {
  if (kind === 'principles') return { text: String(x.text || '').trim().slice(0, 400), source: String(x.source || '').slice(0, 60), learned: !!x.learned };
  if (kind === 'user' || kind === 'notes') return { text: String(x.text || '').trim().slice(0, 1500) };
  if (kind === 'projects') {
    return {
      name: String(x.name || '').trim().slice(0, 60),
      desc: String(x.desc || '').trim().slice(0, 600),
      status: PROJECT_STATUS.includes(x.status) ? x.status : '진행 중',
      notes: Array.isArray(x.notes) ? x.notes.slice(-20) : [],
    };
  }
  return {
    title: String(x.title || '').trim().slice(0, 200),
    due: /^\d{4}-\d{2}-\d{2}$/.test(x.due || '') ? x.due : '',
    projectId: x.projectId || null,
    owner: String(x.owner || '').slice(0, 20),
    status: x.status === 'done' ? 'done' : 'todo',
    source: String(x.source || '').slice(0, 60),
  };
}

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const sameText = (a, b) => norm(a) === norm(b);

module.exports = { Memory, KINDS, PROJECT_STATUS };
