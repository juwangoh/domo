'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Store } = require('./store');
const { Auth } = require('./auth');
const { Orchestrator } = require('./orchestrator');
const { Profiles, PERSONALITIES, PERMISSIONS, MODELS, EFFORTS, PERSONA_TEMPLATES, STUDIO_ROLES } = require('./profiles');
const { Memory, KINDS } = require('./memory');
const { Plugins } = require('./plugins');
const { Scheduler } = require('./scheduler');
const { Tunnel } = require('./tunnel');
const { Uploads } = require('./uploads');
const { Push } = require('./push');
const { engines: defaultEngines } = require('./engines');
const { Connections } = require('./connections');
const { AiSetup } = require('./setup');
const { Evals } = require('./evals');
const team = require('./team');
const { Skills, ACTIVATE_AT, MAX_ACTIVE, ARCHIVE_DAYS } = require('./skills');

const COOKIE = 'aitalk';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
const httpError = (status, message) => Object.assign(new Error(message), { status });

function createApp({
  rootDir, dataDir, configPath, password, engines = defaultEngines, agentOverrides, port = 3939, pushFetch,
  hermesDir = path.join(os.homedir(), '.hermes'), enableScheduler = true, enableTunnel = true, now, workspace, tunnelBins = {},
  connections: connectionsOpt, aiSetupCommands,
} = {}) {
  rootDir ||= path.join(__dirname, '..');
  dataDir ||= path.join(rootDir, 'data');
  configPath ||= path.join(rootDir, 'agents.json');
  const publicDir = path.join(rootDir, 'public');
  workspace ||= path.join(rootDir, 'workspace');
  const transcriptDir = path.join(workspace, '대화기록');
  fs.mkdirSync(transcriptDir, { recursive: true });

  let seed = {};
  try { seed = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* 없음 */ }
  const profiles = new Profiles(dataDir, configPath);
  if (agentOverrides) for (const a of profiles.agents()) Object.assign(a, agentOverrides);
  const store = new Store(dataDir, seed.defaultRooms || []);
  const memory = new Memory(dataDir);
  const plugins = new Plugins(dataDir);
  const auth = new Auth(dataDir, password);
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const uploads = new Uploads(path.join(workspace, '첨부'));
  const push = new Push(dataDir, { fetchImpl: pushFetch });
  // "내 차례"(스튜디오 컨펌)와 완료 보고가 오면 폰으로 알린다.
  bus.on('message', (m) => {
    if (m.sender === 'user' || !push.data.subs.length) return;
    const room = store.getRoom(m.roomId);
    if (!room) return;
    const kind = m.meta?.kind;
    const studioPhase = m.meta?.studio;
    let note = null;
    if (kind === 'gate') note = { title: `${room.name} · 내 차례`, body: m.meta.title?.replace(/^내 차례 · /, '') || m.text };
    else if (studioPhase === 'report' || kind === 'minutes') note = { title: `${room.name} · 완료`, body: m.meta?.label || '보고가 올라왔습니다' };
    else if (kind === 'error') note = { title: `${room.name} · 오류`, body: m.text.slice(0, 120) };
    else if (room.members.length === 1 && m.sender !== 'system') note = { title: profiles.agent(m.sender)?.name || 'DOMO', body: m.text.replace(/\s+/g, ' ').slice(0, 120) };
    if (note) push.sendAll({ ...note, url: `/#/r/${encodeURIComponent(room.id)}`, tag: `room-${room.id}` }).catch(() => {});
  });
  const evals = new Evals(dataDir);
  const connections = connectionsOpt instanceof Connections ? connectionsOpt : new Connections(connectionsOpt || {});
  const aiSetup = new AiSetup({ connections, commands: aiSetupCommands });
  const skills = new Skills(dataDir, workspace);
  skills.prune();
  skills.writeFiles();
  const orch = new Orchestrator({ store, profiles, memory, plugins, engines, bus, workspace, evals, skills, now });

  // 과거 대화 원문을 AI가 검색할 수 있도록 방마다 마크다운으로 남긴다.
  bus.on('message', (m) => {
    const room = store.getRoom(m.roomId);
    if (!room) return;
    const who = m.sender === 'user' ? profiles.user.name : m.sender === 'system' ? '시스템' : profiles.agent(m.sender)?.name || m.sender;
    const line = `\n### ${who} · ${new Date(m.ts).toLocaleString('ko-KR')}\n${m.text}\n`;
    fs.appendFile(path.join(transcriptDir, `${room.id}.md`), line, () => {});
  });

  const scheduler = new Scheduler(dataDir, {
    now,
    onFire: (item) => {
      if (!store.getRoom(item.roomId) || !item.prompt) return;
      orch.userMessage(item.roomId, item.prompt, { scheduled: true, scheduleName: item.name });
      bus.emit('schedules', {});
    },
  });
  if (enableScheduler) scheduler.start();

  const tunnel = new Tunnel({ rootDir, dataDir, port, onChange: (s) => bus.emit('tunnel', s), getProvider: () => profiles.settings.tunnelProvider, ...tunnelBins });
  if (enableTunnel) {
    // 고정 주소(Tailscale Funnel)가 이미 켜져 있으면 그대로 표시하고, 아니면 설정에 따라 켠다.
    setTimeout(async () => {
      await tunnel.refresh().catch(() => {});
      if (profiles.settings.tunnelAuto && tunnel.state.status !== 'on') tunnel.start();
      // 시작 시점에 Tailscale 이 준비되지 않았거나 나중에 Funnel 이 꺼져도, 5분마다 확인해서 다시 켠다.
      const watchdog = setInterval(async () => {
        if (!profiles.settings.tunnelAuto || tunnel.state.status === 'starting') return;
        await tunnel.refresh().catch(() => {});
        if (tunnel.state.status !== 'on') tunnel.start();
      }, 5 * 60 * 1000);
      watchdog.unref();
      server.on('close', () => clearInterval(watchdog));
    }, 500);
  }

  const clients = new Set();
  for (const ev of ['message', 'update', 'typing', 'activity', 'status', 'rooms', 'agents', 'memory', 'schedules', 'tunnel', 'skills']) {
    bus.on(ev, (data) => {
      const chunk = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) res.write(chunk);
    });
  }
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20_000);
  heartbeat.unref();

  // 프로필 편집 화면의 "참여 대화방" 체크 → 단톡방(2명 이상) 멤버십 반영. 1:1 방은 건드리지 않는다.
  function setAgentRooms(agentId, roomIds) {
    if (!Array.isArray(roomIds)) return;
    const want = new Set(roomIds.map(String));
    for (const r of store.listRooms()) {
      if (r.members.length < 2) continue;
      const has = r.members.includes(agentId);
      if (want.has(r.id) && !has) changeMembers(r, { members: [...r.members, agentId] });
      else if (!want.has(r.id) && has && r.members.length > 1) changeMembers(r, { members: r.members.filter((m) => m !== agentId) });
    }
  }

  // 멤버가 바뀌면 대화방에 알림을 남겨서, 사람과 AI 모두 누가 들어오고 나갔는지 알 수 있게 한다.
  function changeMembers(room, patch) {
    const before = [...room.members];
    store.updateRoom(room.id, patch);
    const joined = room.members.filter((m) => !before.includes(m));
    const left = before.filter((m) => !room.members.includes(m));
    const nm = (ids) => ids.map((m) => profiles.agent(m)?.name).filter(Boolean).join(', ');
    if (joined.length && nm(joined)) orch.post(room.id, 'system', `${nm(joined)} 님이 대화방에 참여했습니다`, { kind: 'join' });
    if (left.length && nm(left)) orch.post(room.id, 'system', `${nm(left)} 님이 나갔습니다`, { kind: 'leave' });
  }

  const roomView = (r) => {
    const msgs = store.messages(r.id);
    const p = r.project;
    const project = p ? { id: p.id, title: p.title, stage: p.stage, awaiting: p.awaiting, round: p.round, cancelled: !!p.cancelled } : null;
    return { id: r.id, name: r.name, members: r.members, mode: r.mode, maxRounds: r.maxRounds, createdAt: r.createdAt, running: orch.isRunning(r.id), last: msgs.at(-1) || null, project };
  };
  const clientIp = (req) => {
    const ip = req.socket.remoteAddress || '';
    const loopback = /^(::1|127\.|::ffff:127\.)/.test(ip);
    return (loopback && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim())) || ip;
  };

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
    const method = req.method;

    if (parts[0] === 'health') return json(res, 200, { ok: true });
    const isLocal = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '') && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
    // 로그인 전 첫 화면: 계정이 있는지(로그인) 없는지(회원가입) 알려 준다.
    if (parts[0] === 'setup' && method === 'GET') {
      return json(res, 200, { hasAccount: auth.hasAccount, needsCode: !auth.hasAccount && !isLocal, codespace: !!process.env.CODESPACES, tagline: profiles.settings.tagline || '' });
    }
    if (parts[0] === 'signup' && method === 'POST') {
      const body = await readJson(req);
      const r = auth.signup(body, { local: isLocal });
      if (r.error) { await sleep(300); return json(res, r.status || 400, { error: r.error }); }
      profiles.updateUser({ name: auth.account.name });
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE}=${r.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
      return json(res, 201, { ok: true });
    }
    if (parts[0] === 'files' && method === 'GET') {
      if (!auth.valid(cookies(req)[COOKIE])) return json(res, 401, { error: '로그인이 필요합니다.' });
      const f = uploads.get(parts[1]);
      if (!f) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
      return fs.createReadStream(f.path).pipe(res);
    }
    if (parts[0] === 'login' && method === 'POST') {
      const body = await readJson(req);
      const r = auth.login(body.password || '', clientIp(req), body.email);
      if (r.error) { await sleep(400); return json(res, 401, { error: r.error }); }
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE}=${r.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
      return json(res, 200, { ok: true });
    }

    const token = cookies(req)[COOKIE];
    if (!auth.valid(token)) return json(res, 401, { error: '로그인이 필요합니다.' });

    // 첨부 업로드만 큰 본문(최대 16MB)을 허용한다.
    const isUpload = parts[2] === 'upload';
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readJson(req, isUpload ? 16_000_000 : 2_000_000) : {};
    const [head, id, sub, subId] = parts;
    const canSetup = isLocal && !process.env.CODESPACES;

    switch (head) {
      case 'logout':
        auth.logout(token);
        res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
        return json(res, 200, { ok: true });

      case 'password': {
        if (method !== 'POST') break;
        if (!auth.check(body.current || '')) return json(res, 400, { error: '현재 비밀번호가 올바르지 않습니다.' });
        if (String(body.next || '').length < 4) return json(res, 400, { error: '새 비밀번호는 4자 이상이어야 합니다.' });
        auth.setPassword(body.next);
        const r = auth.login(body.next, clientIp(req)); // 지금 기기는 로그인 유지
        res.setHeader('Set-Cookie', `${COOKIE}=${r.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
        return json(res, 200, { ok: true });
      }

      case 'me':
        return json(res, 200, {
          user: profiles.user, account: auth.account, agents: profiles.agents(), settings: profiles.settings,
          team: { commands: team.COMMANDS, tones: team.TONES, taskOptions: team.TASK_OPTIONS.map(({ id, label }) => ({ id, label })) },
          options: { personalities: PERSONALITIES, permissions: PERMISSIONS, models: MODELS, efforts: EFFORTS, templates: PERSONA_TEMPLATES, studioRoles: STUDIO_ROLES },
          tunnel: tunnel.state,
        });

      case 'events':
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;

      case 'push':
        if (id === 'key' && method === 'GET') return json(res, 200, { publicKey: push.publicKey, count: push.data.subs.length });
        if (id === 'subscribe' && method === 'POST') { push.subscribe(body.subscription); return json(res, 200, { ok: true, count: push.data.subs.length }); }
        if (id === 'unsubscribe' && method === 'POST') { push.unsubscribe(body.endpoint); return json(res, 200, { ok: true }); }
        if (id === 'test' && method === 'POST') {
          const r = await push.sendAll({ title: 'DOMO', body: '알림이 잘 옵니다. 팀이 내 판단을 기다리면 이렇게 알려 드립니다.', url: '/' });
          return json(res, 200, { sent: r.filter((x) => x.ok).length, total: r.length, results: r });
        }
        break;

      case 'connections':
        if (method === 'GET') return json(res, 200, { connections: { ...await connections.status({ refresh: url.searchParams.has('refresh') }), canSetup } });
        break;

      // AI 연결 버튼: 설치(없을 때만) → 로그인을 이 컴퓨터에서 대신 실행한다. 브라우저가 이 컴퓨터에서 열리므로 로컬 접속에서만 허용한다.
      case 'ai-setup':
        if (method === 'GET') return json(res, 200, { setup: aiSetup.status(), canSetup });
        if (method === 'POST' && id) {
          if (!canSetup) return json(res, 403, { error: 'AI 연결은 DOMO가 설치된 컴퓨터에서 진행해 주세요.' });
          const r = sub === 'connect' ? aiSetup.connect(id) : sub === 'code' ? aiSetup.submitCode(id, body.code) : sub === 'cancel' ? aiSetup.cancel(id) : null;
          if (!r) break;
          return r.error ? json(res, r.status || 400, { error: r.error }) : json(res, 200, { ok: true, setup: aiSetup.status() });
        }
        break;

      case 'onboarding':
        if (method === 'POST') {
          const r = await orch.onboarding(body.answers || body);
          return json(res, 200, r);
        }
        break;

      case 'evals':
        if (id && sub === 'choose' && method === 'POST') {
          const item = orch.chooseCompare(String(body.roomId || ''), id, body.choice, body.reason);
          if (!item) throw httpError(400, '비교 기록이 없거나 선택이 올바르지 않습니다.');
          return json(res, 200, { item });
        }
        break;

      case 'skills':
        if (!id && method === 'GET') return json(res, 200, { skills: skills.list(), limits: { activateAt: ACTIVATE_AT, maxActive: MAX_ACTIVE, archiveDays: ARCHIVE_DAYS } });
        if (id && method === 'PATCH') { const x = skills.update(id, body); if (!x) throw httpError(404, '스킬이 없습니다.'); bus.emit('skills', {}); return json(res, 200, { skill: x }); }
        if (id && method === 'DELETE') { skills.remove(id); bus.emit('skills', {}); return json(res, 200, { ok: true }); }
        break;

      case 'insights':
        if (method === 'GET') return json(res, 200, { insights: evals.insights() });
        break;

      case 'account':
        if (method === 'PATCH') { const a = auth.updateAccount(body); if (body.name) profiles.updateUser({ name: body.name }); bus.emit('agents', {}); return json(res, 200, { account: a }); }
        break;

      case 'profile':
        if (method === 'PATCH') { const u = profiles.updateUser(body); bus.emit('agents', {}); return json(res, 200, { user: u }); }
        break;

      case 'settings':
        if (method === 'PATCH') {
          const s = profiles.updateSettings(body);
          return json(res, 200, { settings: s });
        }
        break;

      case 'agents': {
        if (!id && method === 'POST') {
          const a = profiles.createAgent(body);
          if (body.createDm) store.createRoom({ name: a.name, members: [a.id], maxRounds: 1 });
          setAgentRooms(a.id, body.rooms);
          bus.emit('agents', {});
          bus.emit('rooms', {});
          return json(res, 201, { agent: a });
        }
        if (id && method === 'PATCH') {
          const a = profiles.updateAgent(id, body);
          if (!a) throw httpError(404, '프로필이 없습니다.');
          // 엔진이 바뀌면 이전 세션은 이어갈 수 없다.
          if (body.engine) for (const r of store.listRooms()) if (r.agentState[id]) r.agentState[id].sessionId = null;
          store.save();
          setAgentRooms(id, body.rooms);
          bus.emit('agents', {});
          bus.emit('rooms', {});
          return json(res, 200, { agent: a });
        }
        if (id && method === 'DELETE') {
          if (profiles.agents().length <= 1) throw httpError(400, 'AI 프로필은 최소 1개가 필요합니다.');
          profiles.deleteAgent(id);
          // 이 AI만 있던 1:1 방은 지우고, 단톡방에서는 빼낸다.
          for (const r of [...store.listRooms()]) {
            if (!r.members.includes(id)) continue;
            if (r.members.length === 1) { orch.stop(r.id); store.deleteRoom(r.id); memory.deleteRoom(r.id); } else store.updateRoom(r.id, { members: r.members.filter((m) => m !== id) });
          }
          bus.emit('agents', {});
          bus.emit('rooms', {});
          return json(res, 200, { ok: true });
        }
        break;
      }

      case 'plugins': {
        if (!id && method === 'GET') return json(res, 200, { plugins: await plugins.list({ refresh: url.searchParams.has('refresh') }) });
        if (!id && method === 'POST') { const name = plugins.addCustom(body); return json(res, 201, { name, plugins: await plugins.list({ refresh: true }) }); }
        if (id && method === 'DELETE') { plugins.removeCustom(id); return json(res, 200, { plugins: await plugins.list({ refresh: true }) }); }
        break;
      }

      case 'memory': {
        if (!id && method === 'GET') return json(res, 200, { memory: memory.all() });
        if (id === 'import-hermes' && method === 'POST') {
          const added = memory.importHermes(hermesDir);
          bus.emit('memory', {});
          return json(res, 200, { added });
        }
        if (!KINDS.includes(id)) break;
        if (!sub && method === 'POST') {
          const item = memory.add(id, body);
          if (!item) throw httpError(400, '내용이 비었거나 이미 있습니다.');
          bus.emit('memory', {});
          return json(res, 201, { item });
        }
        if (sub && method === 'PATCH') { const item = memory.update(id, sub, body); bus.emit('memory', {}); return json(res, item ? 200 : 404, { item }); }
        if (sub && method === 'DELETE') { memory.remove(id, sub); bus.emit('memory', {}); return json(res, 200, { ok: true }); }
        break;
      }

      case 'schedules': {
        if (!id && method === 'GET') return json(res, 200, { schedules: scheduler.list() });
        if (!id && method === 'POST') { const s = scheduler.create(body); bus.emit('schedules', {}); return json(res, 201, { schedule: s }); }
        if (id && method === 'PATCH') { const s = scheduler.update(id, body); bus.emit('schedules', {}); return json(res, s ? 200 : 404, { schedule: s }); }
        if (id && method === 'DELETE') { scheduler.remove(id); bus.emit('schedules', {}); return json(res, 200, { ok: true }); }
        if (id && sub === 'run' && method === 'POST') {
          const s = scheduler.list().find((x) => x.id === id);
          if (!s || !store.getRoom(s.roomId)) throw httpError(404, '예약 작업 또는 대화방이 없습니다.');
          orch.userMessage(s.roomId, s.prompt, { scheduled: true, scheduleName: s.name });
          return json(res, 200, { ok: true });
        }
        break;
      }

      case 'tunnel':
        if (method === 'GET') { await tunnel.refresh().catch(() => {}); return json(res, 200, { tunnel: tunnel.state }); }
        if (method === 'POST') {
          if (typeof body.auto === 'boolean') profiles.updateSettings({ tunnelAuto: body.auto });
          if (typeof body.provider === 'string' && body.provider !== profiles.settings.tunnelProvider) {
            profiles.updateSettings({ tunnelProvider: body.provider });
            if (tunnel.state.status !== 'off') await tunnel.stop();
          }
          if (body.on === true) await tunnel.start();
          else if (body.on === false) await tunnel.stop();
          return json(res, 200, { tunnel: tunnel.state, settings: profiles.settings });
        }
        break;

      case 'rooms': {
        if (!id) {
          if (method === 'GET') {
            const rooms = store.listRooms().map(roomView).sort((a, b) => (b.last?.ts || b.createdAt) - (a.last?.ts || a.createdAt));
            return json(res, 200, { rooms });
          }
          if (method === 'POST') {
            const members = (body.members || []).filter((m) => profiles.agent(m));
            if (!members.length) throw httpError(400, 'AI를 한 명 이상 선택하세요.');
            const room = store.createRoom({ name: body.name || members.map((m) => profiles.agent(m).name).join(', '), members, maxRounds: body.maxRounds, mode: body.mode });
            bus.emit('rooms', {});
            return json(res, 201, { room: roomView(room) });
          }
          break;
        }
        const room = store.getRoom(id);
        if (!room) throw httpError(404, '대화방이 없습니다.');
        if (!sub) {
          if (method === 'PATCH') {
            if (body.members) body.members = body.members.filter((m) => profiles.agent(m));
            changeMembers(room, body);
            bus.emit('rooms', {});
            return json(res, 200, { room: roomView(room) });
          }
          if (method === 'DELETE') {
            orch.stop(room.id);
            store.deleteRoom(room.id);
            memory.deleteRoom(room.id);
            bus.emit('rooms', {});
            return json(res, 200, { ok: true });
          }
        }
        if (sub === 'messages' && method === 'GET') return json(res, 200, { messages: store.messages(room.id), running: orch.isRunning(room.id) });
        if (sub === 'messages' && method === 'POST') {
          const files = (Array.isArray(body.files) ? body.files : []).map((id) => uploads.get(String(id))).filter(Boolean).slice(0, 8);
          const text = String(body.text || '').trim() || (files.length ? '(첨부)' : '');
          if (!text) throw httpError(400, '빈 메시지');
          if (text.length > 20000) throw httpError(400, '메시지가 너무 깁니다.');
          const meta = {};
          if (files.length) meta.files = files;
          // 답장: 인용한 메시지의 보낸 사람과 앞부분을 함께 남긴다.
          const quoted = body.replyTo ? store.messages(room.id).find((m) => m.id === Number(body.replyTo)) : null;
          if (quoted) meta.reply = { id: quoted.id, sender: quoted.sender, excerpt: quoted.text.replace(/\s+/g, ' ').slice(0, 160) };
          return json(res, 201, { message: orch.userMessage(room.id, text, meta) });
        }
        if (sub === 'upload' && method === 'POST') {
          const file = uploads.save(body);
          return json(res, 201, { file });
        }
        if (sub === 'stop' && method === 'POST') return json(res, 200, { stopped: orch.stop(room.id) });
        if (sub === 'project' && subId === 'cancel' && method === 'POST') {
          if (room.project && room.project.stage !== 'done') {
            Object.assign(room.project, { stage: 'done', awaiting: null, cancelled: true, finishedAt: Date.now() });
            store.save();
            orch.post(room.id, 'system', `프로젝트를 닫았습니다 · ${room.project.title || ''}`, { kind: 'stopped' });
            bus.emit('rooms', {});
          }
          return json(res, 200, { ok: true });
        }
        if (sub === 'reset' && method === 'POST') {
          if (orch.isRunning(room.id)) throw httpError(409, '진행 중에는 초기화할 수 없습니다.');
          store.resetAgents(room.id);
          orch.post(room.id, 'system', 'AI 세션을 초기화했습니다. 장기 기억(내 정보·프로젝트·과제)은 그대로입니다.', { kind: 'reset' });
          return json(res, 200, { ok: true });
        }
        if (sub === 'remember' && method === 'POST') {
          const r = await orch.curate(room.id);
          return json(res, 200, { applied: r?.count || 0 });
        }
        break;
      }
      default:
    }
    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(publicDir, p));
    if (!file.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET') serveStatic(req, res, url);
      else json(res, 405, { error: 'method not allowed' });
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : '서버 오류' });
      if (!err.status) console.error(err);
    }
  });
  server.on('close', () => { scheduler.stop(); tunnel.shutdown(); });

  return { server, store, auth, push, uploads, orch, profiles, memory, plugins, scheduler, tunnel, clients, evals, connections, skills, aiSetup };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, '요청이 너무 큽니다.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'JSON 형식 오류')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { createApp };
