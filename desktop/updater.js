'use strict';
// 앱 업데이트: GitHub Releases 의 최신 설치 파일을 내려받아 지금 앱을 바꿔 끼우고 다시 켠다.
// 서명 없는 배포라 표준 자동 업데이트(Squirrel)를 쓸 수 없어서 직접 처리한다.
//  · Windows: 내려받은 설치 파일을 조용히(/S) 실행한다. 설치가 끝나면 설치 파일이 앱을 다시 켠다.
//  · Mac: dmg 를 마운트해서 지금 실행 중인 DOMO.app 을 새 것으로 바꾸고 다시 연다.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RELEASES_API = 'https://api.github.com/repos/juwangoh/domo/releases/latest';
const ASSET = { darwin: 'DOMO-mac.dmg', win32: 'DOMO-windows.exe' };

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).replace(/^v/, '').split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

class Updater {
  // quit: 설치를 넘긴 뒤 앱을 끝내는 함수. packaged: 설치된 앱인지(개발 모드에서는 확인만 한다).
  constructor({ version, packaged, execPath = process.execPath, platform = process.platform, quit, onChange, fetchImpl = fetch }) {
    this.version = version;
    this.platform = platform;
    this.execPath = execPath;
    this.quit = quit;
    this.onChange = onChange;
    this.fetch = fetchImpl;
    this.asset = null;
    this.state = { supported: !!packaged && !!ASSET[platform], current: version, latest: null, status: 'idle', progress: 0, error: null };
  }

  status() { return { ...this.state }; }
  #set(patch) { Object.assign(this.state, patch); this.onChange?.(this.status()); }

  async check() {
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.status();
    this.#set({ status: 'checking', error: null });
    try {
      const res = await this.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`확인하지 못했습니다 (${res.status})`);
      const rel = await res.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      this.asset = (rel.assets || []).find((a) => a.name === ASSET[this.platform]) || null;
      this.#set({ latest, status: latest && newer(latest, this.version) && this.asset ? 'available' : 'latest' });
    } catch (err) {
      this.#set({ status: 'error', error: err.message || '업데이트를 확인하지 못했습니다.' });
    }
    return this.status();
  }

  // 내려받기 → 검증 → 설치 프로그램에 넘기고 앱 종료. 실패하면 상태에 이유를 남긴다.
  async install() {
    if (!this.state.supported) return this.#fail('이 실행 방식에서는 자동 업데이트를 쓸 수 없습니다. 다운로드 페이지에서 새 버전을 받아 주세요.');
    if (['downloading', 'installing'].includes(this.state.status)) return this.status();
    if (this.state.status !== 'available') await this.check();
    if (this.state.status !== 'available') return this.status();
    try {
      const target = this.platform === 'darwin' ? this.#macAppPath() : null;
      this.#set({ status: 'downloading', progress: 0, error: null });
      const file = await this.#download(this.asset);
      this.#set({ status: 'installing', progress: 1 });
      if (this.platform === 'darwin') this.#installMac(file, target);
      else this.#installWin(file);
      setTimeout(() => this.quit?.(), 300);
    } catch (err) {
      this.#fail(err.message || '업데이트하지 못했습니다.');
    }
    return this.status();
  }

  #fail(error) { this.#set({ status: 'error', error }); return this.status(); }

  async #download(asset) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domo-update-'));
    const file = path.join(dir, asset.name);
    const res = await this.fetch(asset.browser_download_url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`내려받지 못했습니다 (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0;
    let shown = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const p = total ? Math.min(got / total, 0.99) : 0;
      if (p - shown >= 0.02) { shown = p; this.#set({ progress: p }); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (asset.size && got !== asset.size) throw new Error('내려받은 파일이 완전하지 않습니다. 다시 시도해 주세요.');
    // GitHub 가 알려 주는 파일 지문과 맞는지 확인한다.
    const want = String(asset.digest || '').replace(/^sha256:/, '');
    if (want && want !== hash.digest('hex')) throw new Error('내려받은 파일이 원본과 다릅니다. 다시 시도해 주세요.');
    return file;
  }

  // 지금 실행 중인 DOMO.app 의 위치. 바꿔 끼울 수 없는 위치면(디스크 이미지에서 바로 실행 등) 이유를 알려 준다.
  #macAppPath() {
    const appPath = path.resolve(this.execPath, '..', '..', '..');
    if (!appPath.endsWith('.app')) throw new Error('앱 위치를 찾지 못했습니다.');
    if (appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/')) throw new Error('DOMO를 응용 프로그램 폴더로 옮긴 뒤 다시 열어 주세요. 지금 위치에서는 업데이트할 수 없습니다.');
    try { fs.accessSync(path.dirname(appPath), fs.constants.W_OK); } catch { throw new Error('앱이 있는 폴더에 쓸 권한이 없습니다. 다운로드 페이지에서 새 버전을 받아 주세요.'); }
    return appPath;
  }

  #installMac(dmg, appPath) {
    const dir = path.dirname(dmg);
    const script = path.join(dir, 'install.sh');
    // 앱이 끝나기를 기다렸다가 바꾼다. 실패하면 예전 앱을 되돌려 놓고 다시 연다.
    fs.writeFileSync(script, `#!/bin/sh
APP="$1"; DMG="$2"; PID="$3"; MNT="$4/mnt"; OLD="$APP.old-$$"
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done
mkdir -p "$MNT"
if hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null 2>&1 && [ -d "$MNT/DOMO.app" ]; then
  if mv "$APP" "$OLD" && ditto "$MNT/DOMO.app" "$APP"; then
    xattr -dr com.apple.quarantine "$APP" 2>/dev/null
    rm -rf "$OLD"
  else
    rm -rf "$APP"; [ -d "$OLD" ] && mv "$OLD" "$APP"
  fi
fi
hdiutil detach "$MNT" >/dev/null 2>&1
open "$APP"
rm -rf "$4"
`, { mode: 0o755 });
    spawn('/bin/sh', [script, appPath, dmg, String(process.pid), dir], { detached: true, stdio: 'ignore' }).unref();
  }

  #installWin(exe) {
    // electron-builder 의 NSIS 설치 파일: /S 조용히 설치, --force-run 설치 후 앱 다시 실행
    spawn(exe, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  }
}

module.exports = { Updater, newer };
