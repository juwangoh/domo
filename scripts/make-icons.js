'use strict';
// 외부 라이브러리 없이 icon.svg 와 같은 모양의 PNG 아이콘을 그린다 (아이폰 홈 화면용).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function inEllipse(x, y, cx, cy, rx, ry) { return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1; }
function inTri(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = s(px, py, ax, ay, bx, by), d2 = s(px, py, bx, by, cx, cy), d3 = s(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
// 512 기준 좌표에서 색을 고른다 (나중 레이어가 위)
function colorAt(x, y) {
  const t = y / 512;
  let c = [59 + (10 - 59) * t, 155 + (108 - 155) * t, 255 + (240 - 255) * t];
  if (inEllipse(x, y, 210, 215, 132, 104) || inTri(x, y, [120, 270], [80, 347], [175, 300])) c = [255, 255, 255];
  for (const dx of [165, 210, 255]) if (inEllipse(x, y, dx, 215, 15, 15)) c = hex('#D97757');
  if (inEllipse(x, y, 318, 318, 112, 88) || inTri(x, y, [390, 360], [434, 430], [345, 395])) c = hex('#dff0ff');
  for (const dx of [283, 318, 353]) if (inEllipse(x, y, dx, 318, 13, 13)) c = hex('#10A37F');
  return c;
}
function png(size) {
  const ss = 3; // 슈퍼샘플링으로 가장자리를 부드럽게
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = colorAt(((x + (sx + 0.5) / ss) / size) * 512, ((y + (sy + 0.5) / ss) / size) * 512);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = acc[0] / ss / ss; raw[o + 1] = acc[1] / ss / ss; raw[o + 2] = acc[2] / ss / ss; raw[o + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) fs.writeFileSync(path.join(__dirname, '..', 'public', `icon-${s}.png`), png(s));
console.log('아이콘 생성 완료');
