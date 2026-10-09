'use strict';
// v3 기준: 판정만 쓴 감사 답변 처리, 페르소나 만들기 → 단톡방 참여, 고정 주소(Tailscale Funnel).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { Tunnel } = require('../src/tunnel');

const PASSWORD = 'v3-pass';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-v3-'));
let app;
let cookie;

async function api(method, p, body) {
  const res = await fetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie || '' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), setCookie: res.headers.get('set-cookie') };
}
async function waitFor(fn, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('시간 초과');
}
const idle = (roomId) => waitFor(async () => {
  const d = (await api('GET', `/api/rooms/${roomId}/messages`)).data;
  return !d.running && d.messages.at(-1)?.sender !== 'user' ? d.messages : null;
});

test.before(async () => {
  app = createApp({ configPath: require('node:path').join(__dirname, 'fixtures', 'agents.legacy.json'), dataDir, password: PASSWORD, agentOverrides: { engine: 'mock', mockDelayMs: 10 }, enableScheduler: false, enableTunnel: false, workspace: path.join(dataDir, 'ws') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  cookie = (await api('POST', '/api/login', { password: PASSWORD })).setCookie.split(';')[0];
  await api('PATCH', '/api/settings', { autoMemory: false });
});
test.after(async () => {
  for (const res of app.clients) res.end();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('감사 AI가 "판정: 통과" 한 줄만 써도 빈 말풍선 대신 판정 문장이 남는다', async () => {
  await api('POST', '/api/rooms/group/messages', { text: '17×23? #bare-pass' });
  const msgs = await idle('group');
  const review = msgs.find((m) => m.sender === 'codex');
  assert.equal(review.meta.verdict, 'pass');
  assert.notEqual(review.text, '(빈 응답)');
  assert.match(review.text, /문제 없습니다/);
});

test('페르소나 만들기: 템플릿 제공, 체크한 단톡방에 참여 + 1:1 방 생성 + 참여 알림', async () => {
  const me = (await api('GET', '/api/me')).data;
  assert.ok(me.options.templates.length >= 4);
  const r = await api('POST', '/api/agents', { name: '마리코', title: '비서실장', soul: '비서실장이다', engine: 'mock', rooms: ['group', 'meeting'], createDm: true });
  assert.equal(r.status, 201);
  const id = r.data.agent.id;
  const rooms = (await api('GET', '/api/rooms')).data.rooms;
  assert.ok(rooms.find((x) => x.id === 'group').members.includes(id));
  assert.ok(rooms.find((x) => x.id === 'meeting').members.includes(id));
  assert.ok(rooms.some((x) => x.members.length === 1 && x.members[0] === id && x.name === '마리코'));
  const msgs = (await api('GET', '/api/rooms/group/messages')).data.messages;
  assert.equal(msgs.at(-1).meta.kind, 'join');
  assert.match(msgs.at(-1).text, /마리코/);

  // 단톡방에서 새 AI도 차례가 오고, 참여 알림을 본다
  await api('POST', '/api/rooms/meeting/messages', { text: '안건 #agree' });
  const meeting = await idle('meeting');
  assert.ok(meeting.some((m) => m.sender === id));

  // 편집에서 체크 해제하면 빠진다
  await api('PATCH', `/api/agents/${id}`, { rooms: ['meeting'] });
  const after = (await api('GET', '/api/rooms')).data.rooms;
  assert.ok(!after.find((x) => x.id === 'group').members.includes(id));
  assert.match((await api('GET', '/api/rooms/group/messages')).data.messages.at(-1).text, /나갔습니다/);

  // 삭제하면 1:1 방은 지워지고 단톡방에서도 빠진다
  await api('DELETE', `/api/agents/${id}`);
  const gone = (await api('GET', '/api/rooms')).data.rooms;
  assert.ok(!gone.some((x) => x.members.includes(id)));
});

test('고정 주소: Tailscale 이 로그인돼 있으면 Funnel 로 https://<맥>.ts.net 을 열고, 끄면 닫는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitalk-ts-'));
  const bin = path.join(dir, 'tailscale');
  const flag = path.join(dir, 'funnel-on');
  fs.writeFileSync(bin, `#!/bin/sh
case "$*" in
  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"my-mac.tail1234.ts.net."}}' ;;
  "funnel status --json") if [ -f "${flag}" ]; then echo '{"AllowFunnel":{"my-mac.tail1234.ts.net:443":true}}'; else echo '{}'; fi ;;
  "funnel --bg 3939") touch "${flag}"; echo "Available on the internet:"; echo "https://my-mac.tail1234.ts.net/" ;;
  "funnel --https=443 off") rm -f "${flag}" ;;
  *) echo "unknown $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const tunnel = new Tunnel({ rootDir: dir, dataDir: dir, port: 3939, tailscaleBin: bin, cloudflaredBin: null });
  await tunnel.start();
  await waitFor(() => tunnel.state.status === 'on');
  assert.equal(tunnel.state.url, 'https://my-mac.tail1234.ts.net');
  assert.equal(tunnel.state.fixed, true);

  // 서버를 재시작해도(새 Tunnel) 같은 주소가 그대로 켜져 있다
  const again = new Tunnel({ rootDir: dir, dataDir: dir, port: 3939, tailscaleBin: bin, cloudflaredBin: null });
  await again.refresh();
  assert.equal(again.state.status, 'on');
  assert.equal(again.state.url, 'https://my-mac.tail1234.ts.net');

  await again.stop();
  assert.equal(again.state.status, 'off');
  assert.ok(!fs.existsSync(flag));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('작업 모드: 총괄 계획·배정 → 배정된 AI만 실행 → 감사는 완료 기준만 확인 → 최종 보고 + 과제 등록, 반드시 끝난다', async () => {
  const room = (await api('POST', '/api/rooms', { name: '작업방', members: ['claude', 'codex'], mode: 'work', maxRounds: 1 })).data.room;
  assert.equal(room.mode, 'work');
  await api('POST', `/api/rooms/${room.id}/messages`, { text: '판넬 만들어줘' });
  const msgs = await idle(room.id);
  const flow = msgs.map((m) => (m.sender === 'system' ? `system:${m.meta?.kind}` : `${m.sender}:${m.meta?.kind || m.meta?.phase || m.meta?.verdict || ''}`));
  assert.deepEqual(flow.slice(0, 4), ['user:', 'system:meeting-start', 'claude:plan', 'system:assign']);
  assert.ok(flow.includes('claude:task'), '총괄 자신에게도 배정 가능');
  assert.ok(!flow.includes('codex:task'), '감사 AI는 작업에 배정되지 않는다');
  // 감사 1회 수정필요 → 담당 수정 → 재검토, 최대 수정 1회 후 반드시 최종 보고로 끝난다
  assert.ok(flow.includes('codex:revise'));
  assert.ok(flow.includes('claude:fix'));
  const last = msgs.at(-1);
  assert.equal(last.meta.kind, 'minutes');
  assert.equal(last.meta.label, '작업 보고');
  assert.equal(last.meta.tasks.length, 1);
});

test('회의 모드: 2라운드부터는 이견을 낸 AI만 다시 발언하고, 3명 이상이면 과반 합의로 끝난다', async () => {
  const a = (await api('POST', '/api/agents', { name: '셋째', engine: 'mock' })).data.agent;
  const room = (await api('POST', '/api/rooms', { name: '회의방', members: ['claude', 'codex', a.id], mode: 'meeting', maxRounds: 3 })).data.room;
  await api('POST', `/api/rooms/${room.id}/messages`, { text: '안건' });
  const msgs = await idle(room.id);
  const talk = msgs.filter((m) => m.meta?.stance);
  // mock 은 세션의 첫 발언이 이견, 두 번째가 합의 → 1라운드 3명 모두 이견, 2라운드 모두 합의 → 종료
  assert.equal(talk.filter((m) => m.meta.round === 1).length, 3);
  assert.equal(talk.filter((m) => m.meta.round === 2).length, 3);
  assert.ok(!talk.some((m) => m.meta.round === 3));
  assert.equal(msgs.at(-1).meta.kind, 'minutes');
});
