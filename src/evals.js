'use strict';
// 블라인드 비교 기록: "AI 1명 vs 팀" 중 어느 쪽 답이 나았는지 사용자가 고른 결과.
// 교수님 질문("여러 페르소나가 정말 더 효과적인가")에 실측 데이터로 답하기 위한 장치다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Evals {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'evals.json');
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.items = []; }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1));
    fs.renameSync(tmp, this.file);
  }

  // order: 화면의 [A, B] 가 각각 'single' 인지 'team' 인지
  create({ roomId, request, kind, order, single, team }) {
    const item = {
      id: crypto.randomUUID().slice(0, 8), ts: Date.now(), roomId, request: String(request).slice(0, 300), kind,
      order, single, team, choice: null, winner: null, reason: '',
    };
    this.items.push(item);
    this.save();
    return item;
  }

  get(id) { return this.items.find((x) => x.id === id) || null; }

  choose(id, choice, reason = '') {
    const item = this.get(id);
    if (!item) return null;
    if (!['A', 'B', 'tie'].includes(choice)) return null;
    item.choice = choice;
    item.winner = choice === 'tie' ? 'tie' : item.order[choice === 'A' ? 0 : 1];
    item.reason = String(reason || '').slice(0, 300);
    item.chosenAt = Date.now();
    this.save();
    return item;
  }

  // 과제 유형별 팀 승률, 평균 시간·비용
  insights() {
    const done = this.items.filter((x) => x.winner);
    const summarize = (list) => {
      const n = list.length;
      const team = list.filter((x) => x.winner === 'team').length;
      const single = list.filter((x) => x.winner === 'single').length;
      const tie = list.filter((x) => x.winner === 'tie').length;
      const avg = (k, side) => {
        const v = list.map((x) => x[side]?.[k]).filter((y) => typeof y === 'number');
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      return {
        n, team, single, tie,
        teamWinRate: n ? team / n : null,
        singleMs: avg('ms', 'single'), teamMs: avg('ms', 'team'),
        singleCost: avg('costUsd', 'single'), teamCost: avg('costUsd', 'team'),
      };
    };
    const kinds = [...new Set(done.map((x) => x.kind))];
    return {
      total: summarize(done),
      byKind: Object.fromEntries(kinds.map((k) => [k, summarize(done.filter((x) => x.kind === k))])),
      pending: this.items.filter((x) => !x.winner).length,
      recent: done.slice(-10).reverse().map(({ id, ts, kind, request, winner, reason }) => ({ id, ts, kind, request, winner, reason })),
    };
  }
}

module.exports = { Evals };
