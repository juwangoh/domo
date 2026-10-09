'use strict';
// 예약 작업 (Hermes 의 cron 을 벤치마킹): 정해진 요일·시각에 특정 대화방으로 메시지를 보낸다.
// 예) 매일 08:00 "AI 회의실"에 "오늘 과제 우선순위 회의해줘"
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Scheduler {
  constructor(dataDir, { onFire, now = () => new Date() }) {
    this.file = path.join(dataDir, 'schedules.json');
    this.onFire = onFire;
    this.now = now;
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.items = []; }
    this.timer = null;
  }

  save() { fs.writeFileSync(this.file, JSON.stringify(this.items, null, 1)); }
  list() { return this.items; }

  create(input) {
    const item = { id: crypto.randomUUID().slice(0, 8), enabled: true, lastRun: null, ...clean(input) };
    this.items.push(item);
    this.save();
    return item;
  }

  update(id, patch) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return null;
    Object.assign(item, clean({ ...item, ...patch }));
    if (typeof patch.enabled === 'boolean') item.enabled = patch.enabled;
    this.save();
    return item;
  }

  remove(id) {
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 20_000);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); }

  // 예약 시각부터 10분 안에 서버가 켜져 있으면 하루 한 번 실행한다.
  tick() {
    const now = this.now();
    const today = localDate(now);
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const item of this.items) {
      if (!item.enabled || !item.days.includes(now.getDay())) continue;
      const [h, m] = item.time.split(':').map(Number);
      const diff = minutes - (h * 60 + m);
      const key = `${today} ${item.time}`;
      if (diff >= 0 && diff < 10 && item.lastRun !== key) {
        item.lastRun = key;
        this.save();
        this.onFire(item);
      }
    }
  }
}

function clean(x) {
  const days = Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [0, 1, 2, 3, 4, 5, 6];
  return {
    name: String(x.name || '예약 작업').slice(0, 40),
    roomId: String(x.roomId || ''),
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(x.time || '') ? x.time : '08:00',
    days: days.length ? days.sort() : [0, 1, 2, 3, 4, 5, 6],
    prompt: String(x.prompt || '').slice(0, 4000),
  };
}

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { Scheduler, localDate };
