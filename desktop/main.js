'use strict';
// DOMO 데스크톱 앱: 서버를 앱 안에서 켜고 창으로 보여 준다. 창을 닫아도 트레이(메뉴 막대)에 남아서 폰 접속·예약 작업이 계속 돈다.
const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, powerSaveBlocker, shell } = require('electron');
const net = require('node:net');
const path = require('node:path');
const { ensurePath } = require('../src/bins');
const { createApp } = require('../src/app');
const { Updater } = require('./updater');

const DOWNLOAD_PAGE = 'https://juwangoh.github.io/domo/#start';
const MAC = process.platform === 'darwin';
const startHidden = process.argv.includes('--hidden') || (MAC && app.getLoginItemSettings().wasOpenedAsHidden);

app.setName('DOMO');
// 테스트용: 데이터 폴더를 따로 쓰면 설치된 DOMO 와 동시에 켤 수 있다.
if (process.env.DOMO_USER_DATA) app.setPath('userData', process.env.DOMO_USER_DATA);
let win = null;
let tray = null;
let base = null;
let server = null;
let quitting = false;
let updater = null;

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
  updater = new Updater({ version: app.getVersion(), packaged: app.isPackaged, quit: () => app.quit(), onChange: () => tray?.setContextMenu(trayMenu()) });
  const domo = createApp({
    appUpdate: updater,
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
  setTimeout(() => checkUpdate(), 8000);
  setInterval(() => checkUpdate(), 6 * 60 * 60 * 1000).unref();
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

function trayMenu() {
  const u = updater.status();
  const updateItem = u.status === 'available' ? { label: `새 버전 ${u.latest}로 업데이트`, click: () => startUpdate() }
    : u.status === 'downloading' ? { label: `업데이트 내려받는 중 ${Math.round(u.progress * 100)}%`, enabled: false }
      : u.status === 'installing' ? { label: '업데이트 설치 중…', enabled: false }
        : { label: u.status === 'checking' ? '업데이트 확인 중…' : '업데이트 확인', enabled: u.status !== 'checking', click: () => checkUpdate(true) };
  return Menu.buildFromTemplate([
    { label: 'DOMO 열기', click: showWindow },
    { type: 'separator' },
    { label: '컴퓨터를 켤 때 자동으로 실행', type: 'checkbox', checked: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true, args: ['--hidden'] }); tray.setContextMenu(trayMenu()); } },
    { label: `버전 ${app.getVersion()}`, enabled: false },
    updateItem,
    { type: 'separator' },
    { label: 'DOMO 종료', click: () => app.quit() },
  ]);
}

function makeTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: MAC ? 18 : 32, height: MAC ? 18 : 32 });
  tray = new Tray(icon);
  tray.setToolTip('DOMO');
  tray.setContextMenu(trayMenu());
  if (!MAC) tray.on('click', showWindow);
}

// 새 버전이 나오면 알려 주고, 누르면 내려받아 바꿔 끼운 뒤 다시 켠다. manual: 사용자가 직접 확인을 눌렀을 때는 결과를 항상 알려 준다.
let told = null;
async function checkUpdate(manual = false) {
  const u = await updater.check();
  if (u.status === 'available' && (manual || told !== u.latest)) {
    told = u.latest;
    const canInstall = u.supported;
    const { response } = await dialog.showMessageBox({ type: 'info', message: `DOMO 새 버전(${u.latest})이 나왔어요`, detail: canInstall ? '지금 업데이트하면 내려받은 뒤 DOMO가 다시 켜집니다. 대화와 기억은 그대로 유지돼요.' : '다운로드 페이지에서 새 버전을 받아 주세요.', buttons: [canInstall ? '지금 업데이트' : '다운로드 페이지 열기', '나중에'], defaultId: 0, cancelId: 1 });
    if (response === 0) { if (canInstall) startUpdate(); else shell.openExternal(DOWNLOAD_PAGE); }
  } else if (manual) {
    dialog.showMessageBox({ type: 'info', message: u.status === 'error' ? '업데이트를 확인하지 못했어요' : '최신 버전을 쓰고 있어요', detail: u.status === 'error' ? u.error : `버전 ${u.current}`, buttons: ['확인'] });
  }
}

async function startUpdate() {
  const u = await updater.install();
  if (u.status === 'error') {
    const { response } = await dialog.showMessageBox({ type: 'warning', message: '업데이트하지 못했어요', detail: u.error, buttons: ['다운로드 페이지 열기', '닫기'], defaultId: 0, cancelId: 1 });
    if (response === 0) shell.openExternal(DOWNLOAD_PAGE);
  }
}
