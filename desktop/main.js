'use strict';
// DOMO 데스크톱 앱: 서버를 앱 안에서 켜고 창으로 보여 준다. 창을 닫아도 트레이(메뉴 막대)에 남아서 폰 접속·예약 작업이 계속 돈다.
const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, powerSaveBlocker, shell } = require('electron');
const net = require('node:net');
const path = require('node:path');
const { ensurePath } = require('../src/bins');
const { createApp } = require('../src/app');

const RELEASES_API = 'https://api.github.com/repos/juwangoh/domo/releases/latest';
const DOWNLOAD_PAGE = 'https://juwangoh.github.io/domo/#start';
const MAC = process.platform === 'darwin';
const startHidden = process.argv.includes('--hidden') || (MAC && app.getLoginItemSettings().wasOpenedAsHidden);

app.setName('DOMO');
let win = null;
let tray = null;
let base = null;
let server = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('DOMO를 시작하지 못했습니다', String(err?.message || err));
    app.exit(1);
  });
}

// 다른 프로그램이 쓰고 있지 않은 포트를 3939 부터 찾는다.
function freePort(port, tries = 20) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => (tries > 0 ? resolve(freePort(port + 1, tries - 1)) : reject(new Error('사용할 수 있는 포트가 없습니다.'))));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(port)));
  });
}

async function start() {
  ensurePath();
  const port = await freePort(Number(process.env.PORT) || 3939);
  const domo = createApp({
    dataDir: path.join(app.getPath('userData'), 'data'),
    workspace: path.join(app.getPath('documents'), 'DOMO'),
    port,
  });
  server = domo.server;
  app.on('before-quit', () => { quitting = true; domo.aiSetup.stop(); server.close(); });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '0.0.0.0', resolve));
  base = `http://127.0.0.1:${port}`;

  powerSaveBlocker.start('prevent-app-suspension'); // 폰에서 쓰는 동안 컴퓨터가 유휴 잠자기에 들지 않게
  makeTray();
  if (!startHidden) showWindow();
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { /* 트레이에 남는다 */ });
  setTimeout(checkUpdate, 8000);
  setInterval(checkUpdate, 24 * 60 * 60 * 1000).unref();
}

function showWindow() {
  if (!base) return;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 380, minHeight: 560,
    title: 'DOMO', backgroundColor: '#fff5e8', autoHideMenuBar: true,
    icon: MAC ? undefined : path.join(__dirname, 'build', 'icon.png'),
  });
  // 바깥 링크(로그인 창 포함)는 기본 브라우저로 연다.
  const external = (url) => /^https?:/.test(url) && !url.startsWith(base);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (external(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (external(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  win.loadURL(base);
}

function makeTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: MAC ? 18 : 32, height: MAC ? 18 : 32 });
  tray = new Tray(icon);
  tray.setToolTip('DOMO');
  const menu = () => Menu.buildFromTemplate([
    { label: 'DOMO 열기', click: showWindow },
    { type: 'separator' },
    { label: '컴퓨터를 켤 때 자동으로 실행', type: 'checkbox', checked: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true, args: ['--hidden'] }); tray.setContextMenu(menu()); } },
    { label: `버전 ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'DOMO 종료', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu());
  if (!MAC) tray.on('click', showWindow);
}

// 새 버전이 나오면 알려 주고, 내려받는 페이지를 연다. (서명 없는 배포라 자동 교체 대신 안내만 한다)
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).replace(/^v/, '').split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
let told = null;
async function checkUpdate() {
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const latest = (await res.json()).tag_name;
    if (!latest || latest === told || !newer(latest, app.getVersion())) return;
    told = latest;
    const { response } = await dialog.showMessageBox({ type: 'info', message: `DOMO 새 버전(${latest.replace(/^v/, '')})이 나왔어요`, detail: '내려받아 다시 설치하면 대화와 기억은 그대로 유지됩니다.', buttons: ['내려받기', '나중에'], defaultId: 0, cancelId: 1 });
    if (response === 0) shell.openExternal(DOWNLOAD_PAGE);
  } catch { /* 오프라인 */ }
}
