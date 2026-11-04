/* ============================================================
   decoders.js — 브라우저가 못 여는 사진 형식의 전용 디코더 (워커 전용, 지연 로딩)
   ------------------------------------------------------------
   - HEIC/HEIF : libheif-js 1.19.8 (LGPL-3.0, libheif + libde265)
                 사이트 코드와 섞지 않고 CDN 의 별도 파일(ES 모듈 + 내장 wasm)을 그대로 불러온다.
   - TIFF      : UTIF.js 3.1.0 (MIT) + pako 1.0.11 inflate (MIT, Deflate 압축 TIFF 용)
                 두 파일 모두 일반 스크립트(전역 self.UTIF / self.pako)라 받아서 실행한다.
   해당 형식 파일이 처음 들어왔을 때만 내려받는다(JPG·PNG 만 다루면 받지 않음).
   결과는 회전까지 반영한 ImageData. 파일은 이 워커 안에서만 다뤄지고 어디로도 전송되지 않습니다.
   ============================================================ */

const HEIF_URL = 'https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.mjs';
const PAKO_URL = 'https://cdn.jsdelivr.net/npm/pako@1.0.11/dist/pako_inflate.min.js';
const UTIF_URL = 'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js';

const cache = new Map();
function once(key, fn) {
  if (!cache.has(key)) {
    // 받기 실패는 '파일 손상'과 구분해 안내한다
    const p = fn().catch((err) => {
      throw Object.assign(new Error('변환 도구를 내려받지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'), { network: true, cause: err });
    });
    p.catch(() => cache.delete(key));   // 네트워크 실패 시 다음에 다시
    cache.set(key, p);
  }
  return cache.get(key);
}

/** 전역 변수를 만드는 일반 스크립트를 받아 실행 (모듈 워커는 importScripts 를 못 씀) */
async function runScript(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`디코더를 받지 못했습니다 (${r.status})`);
  // eslint-disable-next-line no-new-func
  new Function(await r.text())();
}

/* ---------- HEIC / HEIF ---------- */
const loadHeif = () => once('heif', async () => {
  const factory = (await import(HEIF_URL)).default;
  return new Promise((resolve, reject) => {
    let m = null;
    m = factory({
      onRuntimeInitialized: () => queueMicrotask(() => resolve(m)),
      onAbort: (e) => reject(new Error(`HEIC 디코더 오류: ${e}`)),
    });
    if (m && typeof m.then === 'function') m.then(resolve, reject);
    else if (m && m.calledRun) resolve(m);
  });
});

export async function decodeHeic(bytes) {
  const lib = await loadHeif();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  try {
    if (!images || !images.length) throw new Error('HEIC 안에서 사진을 찾지 못했습니다');
    const img = images[0];                           // 대표(첫) 사진. 회전·반전은 libheif 가 반영
    const w = img.get_width(), h = img.get_height();
    const out = new ImageData(w, h);
    await new Promise((resolve, reject) => {
      img.display(out, (d) => (d ? resolve() : reject(new Error('HEIC 사진을 풀지 못했습니다'))));
    });
    return out;
  } finally {
    if (images) for (const i of images) i.free?.();
    decoder.free?.();
  }
}

/* ---------- TIFF ---------- */
const loadUtif = () => once('utif', async () => {
  await runScript(PAKO_URL);   // UTIF 가 실행될 때 self.pako 를 잡으므로 먼저
  await runScript(UTIF_URL);
  if (!self.UTIF) throw new Error('TIFF 디코더를 불러오지 못했습니다');
  return self.UTIF;
});

export async function decodeTiff(bytes) {
  const UTIF = await loadUtif();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ifds = UTIF.decode(buf).filter((d) => d.t256 && d.t257);
  if (!ifds.length) throw new Error('TIFF 안에서 사진을 찾지 못했습니다');
  // 축소판(NewSubfileType 1)이 아닌 첫 장. 없으면 가장 큰 것
  const ifd = ifds.find((d) => !((d.t254 ? d.t254[0] : 0) & 1))
    || ifds.reduce((a, b) => (b.t256[0] * b.t257[0] > a.t256[0] * a.t257[0] ? b : a));
  UTIF.decodeImage(buf, ifd, ifds);
  const rgba = UTIF.toRGBA8(ifd);
  const img = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, ifd.width * ifd.height * 4), ifd.width, ifd.height);
  return orient(img, ifd.t274 ? ifd.t274[0] : 1);
}

/** EXIF/TIFF 회전값(1~8)을 픽셀에 반영 */
function orient(img, o) {
  if (!(o >= 2 && o <= 8)) return img;
  const w = img.width, h = img.height;
  const swap = o >= 5;
  const a = new OffscreenCanvas(w, h);
  a.getContext('2d').putImageData(img, 0, 0);
  const b = new OffscreenCanvas(swap ? h : w, swap ? w : h);
  const ctx = b.getContext('2d', { willReadFrequently: true });
  const t = {
    2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w],
  }[o];
  ctx.setTransform(...t);
  ctx.drawImage(a, 0, 0);
  return ctx.getImageData(0, 0, b.width, b.height);
}
