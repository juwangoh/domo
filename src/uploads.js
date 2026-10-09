'use strict';
// 첨부 파일: 작업 폴더의 "첨부" 폴더에 저장한다. AI는 이 경로를 Read 도구로 열고(Claude), 이미지는 -i 로 받는다(Codex).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv',
};

class Uploads {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  save({ name, type, data }) {
    const ext = TYPES[type];
    if (!ext) throw Object.assign(new Error('이미지·PDF·텍스트 파일만 첨부할 수 있습니다.'), { status: 400 });
    const buf = Buffer.from(String(data || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) throw Object.assign(new Error('빈 파일입니다.'), { status: 400 });
    if (buf.length > 12_000_000) throw Object.assign(new Error('12MB 이하만 첨부할 수 있습니다.'), { status: 413 });
    const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}.${ext}`;
    const file = path.join(this.dir, id);
    fs.writeFileSync(file, buf);
    const clean = String(name || id).replace(/[\\/\n\r]/g, '_').slice(0, 80);
    fs.writeFileSync(`${file}.name`, clean);
    return this.describe(id, clean, type, buf.length);
  }

  describe(id, name, type, size) {
    return { id, name, type, size, image: type.startsWith('image/'), path: path.join(this.dir, id), url: `/api/files/${id}` };
  }

  get(id) {
    if (!/^[a-z0-9]+\.[a-z]+$/.test(String(id))) return null;
    const file = path.join(this.dir, id);
    if (!fs.existsSync(file)) return null;
    const ext = id.split('.').pop();
    const type = Object.entries(TYPES).find(([, e]) => e === ext)?.[0] || 'application/octet-stream';
    let name = id;
    try { name = fs.readFileSync(`${file}.name`, 'utf8'); } catch { /* 없음 */ }
    return this.describe(id, name, type, fs.statSync(file).size);
  }
}

module.exports = { Uploads };
