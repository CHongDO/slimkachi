/* ============================================================
   pipeline.js — 사진 앱 공용 처리 단계 (워커 전용)
   ------------------------------------------------------------
   디코딩 · 고품질 축소 · 썸네일 · 화질 측정 · 품질 탐색을 모아 둔 모듈.
   사진 용량 줄이기(imageCompress)와 사진 크기 조절(imageResize) 워커가
   함께 씁니다. 메인 스레드에서 import 하지 마세요(픽셀 루프가 무거움).
   ============================================================ */

import { MIME, EXT } from './metadata.js';
import { ssim } from './ssim.js';
import { encode, wasmDecode, QUALITY_RANGE } from './codecs.js';

/**
 * 모드별 화질 기준선. 셋 다 만족해야 통과.
 *  mean  : SSIM 평균 이상
 *  low   : 하위 2% 블록 SSIM 이상 (국소 뭉개짐 방지)
 *  block : 매끈한 영역에 생긴 블록 경계·얼룩 비율 이하 (그라데이션 계단/밴딩 방지)
 * 큰 사진(LARGE_PIXELS 초과)은 화면에서 축소돼 보이므로 SSIM을 절반 해상도로 재고(large),
 * 작은 사진은 원본 해상도로 잰다(small). 두 척도는 값의 범위가 달라 기준도 따로 둔다.
 * 값은 실제 사진으로 품질을 바꿔 가며 눈으로 확인해 맞춘 것. 바꿀 땐 CLAUDE.md 참고.
 */
export const TARGETS = {
  size: {
    small: { mean: 0.955, low: 0.80, block: 0.030 },
    large: { mean: 0.980, low: 0.90, block: 0.030 },
  },
  balanced: {
    small: { mean: 0.972, low: 0.86, block: 0.016 },
    large: { mean: 0.988, low: 0.95, block: 0.016 },
  },
  quality: {
    small: { mean: 0.985, low: 0.92, block: 0.007 },
    large: { mean: 0.994, low: 0.975, block: 0.007 },
  },
};
export const LARGE_PIXELS = 2_500_000;

const SAMPLE_PIXELS = 1_600_000; // 이보다 크면 대표 타일 모자이크로 품질 탐색
const TILE = 256;

export { MIME, EXT, QUALITY_RANGE };

/** 이미지 크기에 맞는 기준선과 SSIM 측정 배율 */
export function targetFor(mode, img) {
  const scale = img.width * img.height > LARGE_PIXELS ? 2 : 1;
  const m = TARGETS[mode] || TARGETS.size;
  return { target: m[scale === 2 ? 'large' : 'small'], scale };
}

/* ---------- 디코딩 / 축소 ---------- */

/**
 * 파일 바이트 → 그리기 가능한 원본. 회전 반영.
 * ① 브라우저 내장 디코더(ImageBitmap) — JPG·PNG·WebP·BMP·GIF(첫 장)·ICO·AVIF 등 브라우저가 읽는 형식 전부
 * ② 그래도 안 되면 전용 디코더(ImageData) — HEIC/HEIF·TIFF 는 decoders.js 를 그때 불러오고,
 *    JPG·WebP·AVIF 는 jSquash WASM 디코더.
 * 어느 쪽도 못 열면 err.unsupported 가 붙은 오류.
 */
export async function decodeSource(bytes, type) {
  const blob = new Blob([bytes], MIME[type] ? { type: MIME[type] } : {});
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  } catch { /* 다음 방법 */ }
  try { return await createImageBitmap(blob); } catch { /* 다음 방법 */ }
  try {
    if (type === 'heic') return await (await import('./decoders.js')).decodeHeic(bytes);
    if (type === 'tiff') return await (await import('./decoders.js')).decodeTiff(bytes);
    if (type === 'jpeg' || type === 'webp' || type === 'avif') return await wasmDecode(type, bytes);
  } catch (err) {
    if (err && err.network) throw err;
    throw Object.assign(new Error('사진을 열 수 없습니다 (파일이 손상되었을 수 있어요)'), { unsupported: !type, cause: err });
  }
  throw Object.assign(new Error('이 형식은 아직 지원하지 않습니다'), { unsupported: true });
}

export function closeSource(src) { if (src && src.close) src.close(); }

/**
 * 원본을 w×h 픽셀(ImageData)로. 원본은 닫지 않으므로 여러 번 다른 크기로 뽑을 수 있다.
 * 크게 줄일 때는 절반씩 단계적으로 줄여 계단·모아레 현상을 막는다.
 */
export async function resizeTo(source, w, h) {
  if (source instanceof ImageData && w === source.width && h === source.height) return source;
  let cur = source instanceof ImageData ? await createImageBitmap(source) : source;
  let own = cur !== source;
  let cw = cur.width, ch = cur.height;
  while (cw / 2 >= w * 1.0001 && ch / 2 >= h) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const step = drawToCanvas(cur, nw, nh);
    if (own) cur.close();
    cur = step.transferToImageBitmap();
    own = true;
    cw = nw; ch = nh;
  }
  const canvas = drawToCanvas(cur, w, h);
  if (own) cur.close();
  return canvas.getContext('2d').getImageData(0, 0, w, h);
}

/** 긴 변 maxDim 이하로 맞춘 크기 (0이면 그대로) */
export function fitLongEdge(w, h, maxDim) {
  if (!(maxDim > 0) || Math.max(w, h) <= maxDim) return { width: w, height: h };
  const s = maxDim / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** 한 번에 디코딩 + (필요 시) 긴 변 제한 */
export async function decodeImage(bytes, type, maxDim = 0) {
  const source = await decodeSource(bytes, type);
  const w0 = source.width, h0 = source.height;
  const { width, height } = fitLongEdge(w0, h0, maxDim);
  try {
    const img = await resizeTo(source, width, height);
    return { img, resized: width !== w0 || height !== h0, origWidth: w0, origHeight: h0 };
  } finally {
    if (!(source instanceof ImageData)) closeSource(source);
  }
}

/** 목록용 작은 미리보기 (메인 화면이 큰 원본을 디코딩하지 않도록) */
export async function makeThumb(img, size = 160) {
  const s = Math.min(1, size / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const bmp = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
  const c = drawToCanvas(bmp, w, h);
  bmp.close();
  return c.convertToBlob({ type: 'image/webp', quality: 0.8 });
}

export function drawToCanvas(bmp, w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return c;
}

async function decodeEncoded(bytes, format, w, h) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: MIME[format] }), { premultiplyAlpha: 'none' });
    if (bmp.width !== w || bmp.height !== h) throw new Error('size mismatch');
    const c = drawToCanvas(bmp, w, h);
    bmp.close();
    return c.getContext('2d').getImageData(0, 0, w, h).data;
  } catch {
    return (await wasmDecode(format, bytes)).data;
  }
}

export function detectAlpha(d) {
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** '#rrggbb' → [r, g, b]. 잘못된 값이면 흰색 */
export function parseColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** JPG 로 저장할 때 투명한 부분을 배경색으로 채운다 (제자리 수정) */
export function flattenOn(d, [r, g, b] = [255, 255, 255]) {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    const k = 255 - a;
    d[i] = (d[i] * a + r * k) / 255;
    d[i + 1] = (d[i + 1] * a + g * k) / 255;
    d[i + 2] = (d[i + 2] * a + b * k) / 255;
    d[i + 3] = 255;
  }
}

/**
 * 출력 형식에 맞춰 알파 처리. bg = JPG 배경색 [r,g,b].
 * filled = 투명 부분을 배경색으로 채웠는지 · opaque = SSIM 을 불투명으로 잴지
 */
export function prepareForFormat(img, srcType, format, bg) {
  const hasAlpha = srcType !== 'jpeg' && detectAlpha(img.data);
  const filled = format === 'jpeg' && hasAlpha;
  if (filled) flattenOn(img.data, bg);
  return { hasAlpha, filled, opaque: !hasAlpha || format === 'jpeg' };
}

/* ---------- 화질 측정 / 품질 탐색 ---------- */

/** 큰 이미지는 고르게 뽑은 타일을 이어 붙인 모자이크로 탐색해 시간을 줄인다. */
function buildSample(img) {
  const { width: w, height: h, data } = img;
  if (w * h <= SAMPLE_PIXELS * 1.5 || w < TILE * 2 || h < TILE * 2) return img;
  const n = Math.floor(SAMPLE_PIXELS / (TILE * TILE));
  let gx = Math.max(1, Math.round(Math.sqrt(n * w / h)));
  let gy = Math.max(1, Math.floor(n / gx));
  gx = Math.min(gx, Math.floor(w / TILE));
  gy = Math.min(gy, Math.floor(h / TILE));
  const mw = gx * TILE, mh = gy * TILE;
  const out = new Uint8ClampedArray(mw * mh * 4);
  const src32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const dst32 = new Uint32Array(out.buffer);
  for (let j = 0; j < gy; j++) {
    const sy = Math.min(h - TILE, Math.max(0, Math.round((j + 0.5) * h / gy - TILE / 2)));
    for (let i = 0; i < gx; i++) {
      const sx = Math.min(w - TILE, Math.max(0, Math.round((i + 0.5) * w / gx - TILE / 2)));
      for (let r = 0; r < TILE; r++) {
        const s = (sy + r) * w + sx;
        dst32.set(src32.subarray(s, s + TILE), (j * TILE + r) * mw + i * TILE);
      }
    }
  }
  return new ImageData(out, mw, mh);
}

export const passes = (s, t) => s.mean >= t.mean && s.low >= t.low && s.blockiness <= t.block;

/** 인코딩된 결과를 다시 풀어 원본 픽셀과 비교 */
export async function score(format, img, bytes, opaque, scale) {
  const dec = await decodeEncoded(bytes, format, img.width, img.height);
  return ssim(img.data, dec, img.width, img.height, opaque, scale);
}

async function trial(format, img, q, mode, opaque, scale, extra) {
  const bytes = await encode(format, img, q, mode, extra);
  return { bytes, score: await score(format, img, bytes, opaque, scale) };
}

/**
 * 기준선(target)을 통과하는 가장 낮은 품질 = 가장 작은 파일을 이분 탐색.
 * report(label, 0~1) 로 진행 상황을 알린다. 통과하는 품질이 없으면 null.
 * extra 는 encode() 로 그대로 넘긴다 (예: { gray: true }).
 */
export async function searchQuality(format, img, mode, target, opaque, scale, report = () => {}, extra = {}) {
  const [qMin, qMax] = QUALITY_RANGE[format];
  const sample = buildSample(img);
  const isFull = sample === img;
  const steps = Math.ceil(Math.log2(qMax - qMin + 1)) + 1;
  let step = 0;
  const tick = (label) => report(label, 0.82 * Math.min(1, ++step / steps));

  let lo = qMin, hi = qMax, best = null;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    tick(`최적 화질 찾는 중 (품질 ${q})`);
    const t = await trial(format, sample, q, mode, opaque, scale, extra);
    if (passes(t.score, target)) { best = { q, ...t }; hi = q - 1; }
    else lo = q + 1;
  }
  if (!best) return null;

  if (isFull) {
    return { bytes: best.bytes, quality: best.q, ssim: best.score.mean, ssimLow: best.score.low };
  }

  // 전체 이미지로 최종 인코딩 + 검증. 모자이크와 차이가 나면 품질을 조금씩 올림.
  let q = best.q;
  let failed = q - 1;
  for (let attempt = 0; attempt < 3; attempt++) {
    report(`전체 이미지 인코딩 (품질 ${q})`, 0.85 + attempt * 0.04);
    const t = await trial(format, img, q, mode, opaque, scale, extra);
    if (passes(t.score, target)) return { bytes: t.bytes, quality: q, ssim: t.score.mean, ssimLow: t.score.low };
    if (q >= qMax) return null;
    failed = q;
    q = Math.min(qMax, q + 4);
  }
  // 모자이크와 전체 이미지의 차이가 커서 세 번 안에 못 찾았으면, 남은 범위를 전체 이미지로 이분 탐색
  // (전에는 여기서 포기하고 원본을 유지했다. 기준은 같고 통과하는 품질을 끝까지 찾을 뿐)
  let a = failed + 1, z = qMax, found = null;
  while (a <= z) {
    const mid = (a + z) >> 1;
    report(`전체 이미지로 다시 찾는 중 (품질 ${mid})`, 0.97);
    const t = await trial(format, img, mid, mode, opaque, scale, extra);
    if (passes(t.score, target)) { found = { q: mid, ...t }; z = mid - 1; } else a = mid + 1;
  }
  return found ? { bytes: found.bytes, quality: found.q, ssim: found.score.mean, ssimLow: found.score.low } : null;
}

/**
 * maxBytes 이하가 되는 가장 높은 품질을 이분 탐색 (용량 → 품질 방향).
 * [lo, hi] 범위 안에서만 찾는다. 범위 안 어떤 품질도 안 맞으면 null.
 * known: 이미 재 본 { q: bytes } (중복 인코딩 방지)
 */
export async function fitUnder(format, img, maxBytes, mode, { lo, hi, known = new Map(), report = () => {} } = {}) {
  const [qMin, qMax] = QUALITY_RANGE[format];
  lo = Math.max(qMin, lo ?? qMin);
  hi = Math.min(qMax, hi ?? qMax);
  const enc = async (q) => {
    if (!known.has(q)) { report(q); known.set(q, await encode(format, img, q, mode)); }
    return known.get(q);
  };
  // 가장 낮은 품질도 안 들어가면 탐색할 필요가 없다
  if ((await enc(lo)).length > maxBytes) return null;
  let best = lo;
  let a = lo + 1, b = hi;
  while (a <= b) {
    const q = (a + b) >> 1;
    if ((await enc(q)).length <= maxBytes) { best = q; a = q + 1; }
    else b = q - 1;
  }
  return { q: best, bytes: known.get(best) };
}

/**
 * 형식 변환 정보 (결과 객체에 덧붙임). 화면이 안내 문구를 만든다.
 *  srcFormat 원본 형식 · converted 저장 형식이 바뀌었는지(이때는 '원본보다 크면 원본 유지'를 적용하지 않음)
 *  filled    JPG 로 바꾸며 투명 부분을 채운 배경색('#rrggbb', 안 채웠으면 '')
 *  firstFrame 움직이는 이미지의 첫 장면만 저장했는지 · grew 변환으로 용량이 늘었는지
 */
export function convInfo(type, format, { srcSize, size, filled, bg, animated }) {
  const converted = format !== type;
  return {
    srcFormat: type, converted,
    filled: filled ? (bg || '#ffffff') : '',
    firstFrame: !!(converted && animated),
    grew: !!(converted && size > srcSize),
  };
}

/** 워커 → 화면으로 보낼 결과 객체 */
export function packResult(kind, bytes, format, extra = {}) {
  return { kind, bytes, size: bytes.length, mime: MIME[format], ext: EXT[format], ...extra };
}
