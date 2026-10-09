'use strict';
// 대화방·메시지·AI 세션 상태를 JSON 파일 하나에 저장한다 (원자적 쓰기).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Store {
  constructor(dataDir, defaultRooms = []) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
    let changed = false;
    for (const r of this.data.rooms) if (!r.mode) { r.mode = cleanMode(null, r.members); changed = true; }
    // 기본 방은 한 번만 만든다. 나중에 추가된 기본 방(예: AI 회의실)도 기존 사용자에게 한 번 생기고, 지우면 다시 안 생긴다.
    if (!this.data.seeded) {
      this.data.seeded = this.data.initialized ? this.data.rooms.map((r) => r.id) : [];
      changed = true;
    }
    for (const r of defaultRooms) {
      if (this.data.seeded.includes(r.id)) continue;
      if (!this.getRoom(r.id)) this.createRoom(r, { save: false });
      this.data.seeded.push(r.id);
      changed = true;
    }
    this.data.initialized = true;
    if (changed) this.save();
  }

  #load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { rooms: [], messages: {}, seq: 0, ...d };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 깨진 파일은 지우지 않고 옆에 보관한다.
        fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
      }
      return { rooms: [], messages: {}, seq: 0 };
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  listRooms() { return this.data.rooms; }
  getRoom(id) { return this.data.rooms.find((r) => r.id === id); }

  createRoom({ id, name, members, maxRounds = 3, mode }, { save = true } = {}) {
    const room = {
      id: id || crypto.randomUUID().slice(0, 8),
      name: String(name || '새 대화').slice(0, 60),
      members: [...members],
      mode: cleanMode(mode, members),
      maxRounds: clampRounds(maxRounds),
      createdAt: Date.now(),
      agentState: {},
    };
    this.data.rooms.push(room);
    this.data.messages[room.id] = [];
    if (save) this.save();
    return room;
  }

  updateRoom(id, patch) {
    const room = this.getRoom(id);
    if (!room) return null;
    if (patch.name !== undefined) room.name = String(patch.name).slice(0, 60) || room.name;
    if (patch.maxRounds !== undefined) room.maxRounds = clampRounds(patch.maxRounds);
    if (Array.isArray(patch.members) && patch.members.length) room.members = [...new Set(patch.members.map(String))];
    if (patch.mode !== undefined || patch.members) room.mode = cleanMode(patch.mode ?? room.mode, room.members);
    this.save();
    return room;
  }

  deleteRoom(id) {
    this.data.rooms = this.data.rooms.filter((r) => r.id !== id);
    delete this.data.messages[id];
    this.save();
  }

  resetAgents(id) {
    const room = this.getRoom(id);
    if (!room) return null;
    room.agentState = {};
    this.save();
    return room;
  }

  agentState(room, agentId) {
    room.agentState[agentId] ||= { sessionId: null, cursor: 0 };
    return room.agentState[agentId];
  }

  messages(roomId) { return this.data.messages[roomId] || []; }

  messagesSince(roomId, cursor) { return this.messages(roomId).filter((m) => m.id > cursor); }

  addMessage(roomId, { sender, text, meta }) {
    const msg = { id: ++this.data.seq, roomId, sender, text, ts: Date.now() };
    if (meta && Object.keys(meta).length) msg.meta = meta;
    (this.data.messages[roomId] ||= []).push(msg);
    this.save();
    return msg;
  }
}

function cleanMode(mode, members) {
  if (members.length < 2) return 'chat';
  return ['studio', 'work', 'meeting', 'review'].includes(mode) ? mode : 'review';
}

function clampRounds(n) {
  const v = Number.parseInt(n, 10);
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), 10) : 3;
}

module.exports = { Store };
