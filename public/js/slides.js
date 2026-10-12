'use strict';
// 크리틱용 장표 준비: 이미지·PDF 를 장표 단위로 나누고 번호를 붙인다.
// AI 가 위치를 정확히 짚도록, AI 에게 보내는 사본에는 가장자리에 0~100 좌표축을 붙인다.
// (이미지 위에 격자를 덮으면 오히려 방해가 되므로 여백에만 눈금을 그린다.)
(() => {
  const D = window.D;
  const VIEW_MAX = 2000; // 화면에 보여 줄 원본 사본의 긴 변
  const AI_MAX = 1500; // AI 에게 보낼 사본의 긴 변 (여백 제외)
  const PAD = { left: 64, top: 52, right: 14, bottom: 14 };

  let pdfjs = null;
  async function loadPdfjs() {
    if (!pdfjs) {
      pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    }
    return pdfjs;
  }

  const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; };
  function scaled(src, w, h, max) {
    const k = Math.min(1, max / Math.max(w, h));
    const c = canvasOf(w * k, h * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  // 여백에 좌표축과 장표 번호를 그린 사본
  function withAxis(src, n) {
    const body = scaled(src, src.width, src.height, AI_MAX);
    const c = canvasOf(body.width + PAD.left + PAD.right, body.height + PAD.top + PAD.bottom);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(body, PAD.left, PAD.top);
    g.strokeStyle = '#111';
    g.fillStyle = '#111';
    g.lineWidth = 2;
    g.strokeRect(PAD.left - 1, PAD.top - 1, body.width + 2, body.height + 2);
    g.font = '600 15px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let v = 0; v <= 100; v += 10) {
      const x = PAD.left + (body.width * v) / 100;
      const y = PAD.top + (body.height * v) / 100;
      g.beginPath(); g.moveTo(x, PAD.top - 10); g.lineTo(x, PAD.top - 1); g.stroke();
      g.beginPath(); g.moveTo(PAD.left - 10, y); g.lineTo(PAD.left - 1, y); g.stroke();
      g.textAlign = 'center';
      g.fillText(String(v), Math.min(c.width - 16, Math.max(PAD.left + 8, x)), PAD.top - 22);
      g.textAlign = 'right';
      g.fillText(String(v), PAD.left - 14, Math.min(c.height - 10, Math.max(PAD.top + 8, y)));
    }
    g.textAlign = 'left';
    g.font = '700 17px system-ui, sans-serif';
    g.fillText(`${String(n).padStart(2, '0')}번`, 6, 14);
    return c;
  }

  const jpeg = (c, q = 0.86) => ({ data: c.toDataURL('image/jpeg', q), type: 'image/jpeg' });

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name}을(를) 읽을 수 없습니다.`)); };
      img.src = url;
    });
  }

  // 파일 하나를 장표(들)로 바꾼다. 반환: [{ name, canvas, width, height }]
  async function pagesOf(file, onProgress) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const lib = await loadPdfjs();
      const doc = await lib.getDocument({ data: await file.arrayBuffer(), cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' }).promise;
      const out = [];
      for (let i = 1; i <= doc.numPages; i++) {
        onProgress?.(`${file.name} · ${i}/${doc.numPages}쪽 변환 중`);
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: VIEW_MAX / Math.max(base.width, base.height) });
        const c = canvasOf(viewport.width, viewport.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
        out.push({ name: `${file.name.replace(/\.pdf$/i, '')} ${i}쪽`, canvas: c, width: null, height: null });
      }
      await doc.destroy();
      return out;
    }
    const img = await loadImage(file);
    return [{ name: file.name, canvas: scaled(img, img.naturalWidth, img.naturalHeight, VIEW_MAX), width: img.naturalWidth, height: img.naturalHeight }];
  }

  D.slides = {
    MAX: 30,
    // 파일들을 장표 목록으로: [{ name, thumb, width, height, view(), ai(n) }]
    async fromFiles(files, onProgress) {
      const out = [];
      for (const file of files) {
        for (const p of await pagesOf(file, onProgress)) {
          out.push({
            name: p.name, width: p.width, height: p.height,
            thumb: scaled(p.canvas, p.canvas.width, p.canvas.height, 360).toDataURL('image/jpeg', 0.8),
            view: () => jpeg(p.canvas),
            ai: (n) => jpeg(withAxis(p.canvas, n), 0.84),
          });
        }
      }
      return out;
    },
  };
})();
