/* ============================================================
   imageResize.js — 사진 크기 조절 엔진 (UI 없음, 워커 안에서만 import)
   ------------------------------------------------------------
   방식
   - percent : 원본의 N% 크기로
   - pixels  : 가로·세로 지정 (비율 유지 시 그 칸 안에 맞춤)
   - target  : 목표 용량 이하로. ① 해상도 그대로 품질을 낮춰 보고
               ② 그래도 안 되거나 화질 기준을 못 넘으면 해상도를 단계적으로 줄여,
               목표 이하이면서 화질이 가장 좋은(해상도가 가장 큰) 결과를 고른다.
   원본보다 크게 늘리지 않는다(업스케일 금지).
   resizeImage(file, { method, percent | width,height,keepRatio | targetBytes, format, mode, bg }, ctx)
   mode(size/balanced/quality)는 비율·픽셀 방식에서 저장 화질 기준으로 쓴다(없으면 balanced).
   저장 형식이 원본과 같을 때만 '원본 유지·원본보다 크면 맞춤' 규칙을 쓰고, 형식을 바꾸면(사용자 선택 또는
   BMP·HEIC 등 자동 변환) 결과가 커져도 변환 결과를 돌려준다. JPG 로 바꿀 때 투명 부분은 bg 색으로 채운다.
   공용 단계(디코딩·인코더·화질 측정)는 js/shared/image/ 에 있습니다.
   ============================================================ */

import { detectType, stripMetadata, isAnimated, outputFormat } from '../shared/image/metadata.js';
import { encode, optimisePng } from '../shared/image/codecs.js';
import {
  TARGETS, MIME, EXT, QUALITY_RANGE, targetFor, decodeSource, closeSource, resizeTo, makeThumb,
  prepareForFormat, searchQuality, fitUnder, score, passes, packResult, parseColor, convInfo,
} from '../shared/image/pipeline.js';

const RESIZE_MODE = 'balanced';          // 크기만 바꿀 때 기본 저장 화질 기준 (눈에 띄는 손상 없음)
const TARGET_MODE = 'size';              // 목표 용량 모드에서 '이 정도면 괜찮다'로 보는 기준
const REF_Q = { jpeg: 75, webp: 75, avif: 55 };    // 목표 용량 모드에서 다음 해상도를 어림할 때 쓰는 품질
const GATE_MIN_EDGE = 640;               // 긴 변이 이 이하면 화질 기준을 못 넘어도 목표에 맞춘 결과를 채택
const MAX_STEPS = 14;

export async function resizeImage(file, o, ctx) {
  const src = new Uint8Array(await file.arrayBuffer());
  const type = detectType(src);
  if (type === 'svg' || type === 'psd') throw Object.assign(new Error('이 형식은 아직 지원하지 않습니다'), { notice: true });
  const stripped = stripMetadata(type, src);
  const format = outputFormat(o.format, type);
  const same = format === type;
  const animated = isAnimated(type, src);
  const bg = parseColor(o.bg);
  const lightest = stripped.bytes && stripped.bytes.length < src.length ? stripped.bytes : null;
  // 형식 변환 정보를 결과에 덧붙인다 (같은 형식이면 converted:false)
  const conv = (r) => ({ ...r, ...convInfo(type, format, { srcSize: src.length, size: r.size, filled: r.filled, bg: o.bg, animated }) });

  if (animated && same) {
    return keep(type, src.length, lightest, null,
      '움직이는 이미지는 크기를 바꾸면 움직임이 사라져 원본을 유지했습니다');
  }

  ctx.progress('이미지 해석', 0.04);
  const source = await decodeSource(src, type);
  try {
    makeThumb(source).then(ctx.thumb, () => {});
    const W = source.width, H = source.height;
    const orig = { origWidth: W, origHeight: H };

    if (o.method === 'target') {
      const T = Math.floor(Number(o.targetBytes) || 0);
      if (!(T > 0)) throw new Error('목표 용량을 입력해 주세요');
      // 원래 형식 그대로이고 이미 목표 이하면 손대지 않는다 (메타데이터만 정리)
      if (same && (lightest || src).length <= T) {
        return keep(type, src.length, lightest, { width: W, height: H, ...orig },
          '이미 목표 용량 이하라 해상도·화질을 그대로 두었습니다', { targetBytes: T });
      }
      const r = format === 'png'
        ? await fitTargetPng(source, T, ctx)
        : await fitTargetLossy(source, type, format, T, ctx, bg);
      return conv({ ...r, ...orig, targetBytes: T });
    }

    const dims = computeDims(W, H, o);
    const blocked = dims.upscale ? '지정 크기가 원본보다 커서 늘리지 않았습니다' : '';
    if (dims.width === W && dims.height === H && same) {
      return keep(type, src.length, lightest, { width: W, height: H, ...orig },
        blocked ? `원본(${W}×${H})이 지정 크기보다 작아 그대로 두었습니다 (확대 안 함)` : '크기 변화가 없어 원본을 유지했습니다');
    }

    ctx.progress(`${dims.width}×${dims.height}로 줄이는 중`, 0.1);
    const img = await resizeTo(source, dims.width, dims.height);
    const mode = TARGETS[o.mode] ? o.mode : RESIZE_MODE;
    const r = await encodeResized(img, type, format, src.length, ctx, mode, bg);
    return conv({ ...r, width: img.width, height: img.height, ...orig, note: [r.note, blocked].filter(Boolean).join(' · ') });
  } finally {
    if (!(source instanceof ImageData)) closeSource(source);
  }
}

/** 원본(또는 메타데이터만 지운 원본)을 그대로 돌려준다 */
function keep(type, origSize, lightest, dims, note, extra = {}) {
  if (lightest) return packResult('stripped', lightest, type, { ...dims, ssim: 1, note: `${note} (메타데이터만 제거)`, ...extra });
  return { kind: 'original', size: origSize, mime: MIME[type], ext: EXT[type], ssim: 1, ...dims, note, ...extra };
}

/** 비율·픽셀 지정 → 실제 결과 크기 (업스케일 금지) */
export function computeDims(W, H, o) {
  let w = W, h = H, upscale = false;
  if (o.method === 'percent') {
    const p = Number(o.percent);
    if (p > 100) upscale = true;
    const s = Math.min(100, Math.max(1, p || 100)) / 100;
    w = W * s; h = H * s;
  } else {
    const tw = Number(o.width) > 0 ? Number(o.width) : 0;
    const th = Number(o.height) > 0 ? Number(o.height) : 0;
    if (o.keepRatio !== false) {
      let s = Infinity;
      if (tw) s = Math.min(s, tw / W);
      if (th) s = Math.min(s, th / H);
      if (s === Infinity) s = 1;
      if (s > 1) upscale = true;
      s = Math.min(1, s);
      w = W * s; h = H * s;
    } else {
      if (tw > W || th > H) upscale = true;
      w = Math.min(W, tw || W);
      h = Math.min(H, th || H);
    }
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), upscale };
}

/** 줄인 이미지를 저장. 화질 기준을 통과하는 가장 작은 품질로. */
async function encodeResized(img, srcType, format, origSize, ctx, mode, bg) {
  const { opaque, filled } = prepareForFormat(img, srcType, format, bg);
  if (format === 'png') {
    ctx.progress('PNG 무손실 저장', 0.3);
    const bytes = await optimisePng(img, img.width * img.height > 4_000_000 ? 1 : 2);
    return packResult('lossless', bytes, 'png', { ssim: 1, note: '무손실 저장' });
  }
  const { target, scale } = targetFor(mode, img);
  const report = (label, f) => ctx.progress(label, 0.15 + 0.8 * f);
  const found = await searchQuality(format, img, mode, target, opaque, scale, report);
  let bytes = found ? found.bytes : await encode(format, img, QUALITY_RANGE[format][1], mode);
  let quality = found ? found.quality : QUALITY_RANGE[format][1];
  let note = '';
  // 같은 형식인데 크기를 줄였더니 오히려 커졌다면(원본이 강하게 압축된 경우) 원본 용량 아래로 맞춘다
  if (format === srcType && bytes.length >= origSize) {
    const fit = await fitUnder(format, img, Math.floor(origSize * 0.97), mode, { hi: quality });
    if (fit) { bytes = fit.bytes; quality = fit.q; note = '원본보다 커지지 않도록 화질을 맞췄습니다'; }
  }
  const s = await score(format, img, bytes, opaque, scale);
  return packResult('lossy', bytes, format, { quality, ssim: s.mean, ssimLow: s.low, note, filled });
}

/* ---------- 목표 용량 ---------- */

/**
 * 손실 형식(JPG/WebP). 해상도 배율 s 에서:
 *  - 목표 이하가 되는 가장 높은 품질을 찾고
 *  - 그 결과가 화질 기준(용량 우선 모드와 같은 기준)을 넘으면 채택.
 * 못 넘으면 해상도를 줄여 다시. 채택 후에는 실패한 배율과의 사이를 최대 세 번 더 좁혀
 * 가능한 한 큰 해상도를 고른다.
 */
async function fitTargetLossy(source, srcType, format, T, ctx, bg) {
  const W = source.width, H = source.height;
  const [qMin, qMax] = QUALITY_RANGE[format];
  const qRef = REF_Q[format];
  let step = 0;

  async function tryScale(s) {
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    step++;
    const base = 0.06 + 0.9 * (1 - 0.72 ** step);
    ctx.progress(s === 1 ? `화질을 낮춰 맞추는 중 (${w}×${h})` : `해상도를 줄여 맞추는 중 (${w}×${h})`, base);
    const img = await resizeTo(source, w, h);
    const { opaque, filled } = prepareForFormat(img, srcType, format, bg);
    const known = new Map();
    const refBytes = await encode(format, img, qRef, TARGET_MODE);
    known.set(qRef, refBytes);
    const range = refBytes.length <= T ? { lo: qRef, hi: qMax } : { lo: qMin, hi: qRef - 1 };
    const fit = await fitUnder(format, img, T, TARGET_MODE, { ...range, known });
    const out = { s, w, h, refSize: refBytes.length, fit: null, ok: false, filled };
    if (!fit) return out;
    const { target, scale } = targetFor(TARGET_MODE, img);
    const sc = await score(format, img, fit.bytes, opaque, scale);
    out.fit = { bytes: fit.bytes, quality: fit.q, ssim: sc.mean, ssimLow: sc.low };
    out.ok = passes(sc, target);
    return out;
  }

  let s = 1, failedAt = null, accepted = null, fallback = null;
  for (let i = 0; i < MAX_STEPS; i++) {
    const t = await tryScale(s);
    const longEdge = Math.max(t.w, t.h);
    if (t.fit && (t.ok || longEdge <= GATE_MIN_EDGE)) { accepted = t; break; }
    if (t.fit && !fallback) fallback = t;
    if (longEdge <= 16) break;
    failedAt = s;
    // 다음 배율 어림: 기준 품질(qRef)에서 목표에 맞을 만큼 (용량 ≈ 화소 수에 비례)
    let ratio = Math.sqrt(T / t.refSize) * 0.97;
    if (!(ratio < 0.92)) ratio = 0.85;
    s *= Math.max(0.25, ratio);
  }

  if (!accepted && fallback) accepted = fallback;
  if (!accepted) throw new Error('목표 용량이 너무 작아 맞출 수 없습니다');

  // 실패한 배율과 채택한 배율 사이를 좁혀 더 큰 해상도를 노린다
  if (accepted.ok && failedAt) {
    let lo = accepted.s, hi = failedAt;
    for (let k = 0; k < 3 && hi / lo > 1.05; k++) {
      const mid = Math.sqrt(lo * hi);
      const t = await tryScale(mid);
      if (t.fit && t.ok) { accepted = t; lo = mid; } else hi = mid;
    }
  }

  const resized = accepted.s < 1;
  const notes = [resized ? '화질을 지키려고 해상도를 줄여 맞췄습니다' : '해상도는 그대로, 화질만 조정했습니다'];
  return packResult('lossy', accepted.fit.bytes, format, {
    width: accepted.w, height: accepted.h, quality: accepted.fit.quality,
    ssim: accepted.fit.ssim, ssimLow: accepted.fit.ssimLow, filled: accepted.filled,
    note: notes.join(' · '),
    warn: accepted.ok ? '' : '목표에 맞추느라 화질이 다소 떨어졌습니다',
  });
}

/** PNG 유지: 픽셀은 무손실 그대로, 해상도만 줄여 맞춘다 */
async function fitTargetPng(source, T, ctx) {
  const W = source.width, H = source.height;
  let step = 0;
  async function tryScale(s) {
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    step++;
    ctx.progress(`해상도를 줄여 맞추는 중 (${w}×${h})`, 0.06 + 0.9 * (1 - 0.72 ** step));
    const img = await resizeTo(source, w, h);
    const bytes = await optimisePng(img, w * h > 2_000_000 ? 1 : 2);
    return { s, w, h, bytes };
  }
  let s = 1, failedAt = null, accepted = null, last = null;
  for (let i = 0; i < MAX_STEPS; i++) {
    last = await tryScale(s);
    if (last.bytes.length <= T) { accepted = last; break; }
    if (Math.max(last.w, last.h) <= 16) break;
    failedAt = s;
    s *= Math.max(0.25, Math.min(0.92, Math.sqrt(T / last.bytes.length) * 0.97));
  }
  if (!accepted) throw new Error('목표 용량이 너무 작아 맞출 수 없습니다');
  if (failedAt) {
    let lo = accepted.s, hi = failedAt;
    for (let k = 0; k < 3 && hi / lo > 1.05; k++) {
      const mid = Math.sqrt(lo * hi);
      const t = await tryScale(mid);
      if (t.bytes.length <= T) { accepted = t; lo = mid; } else hi = mid;
    }
  }
  return packResult('lossless', accepted.bytes, 'png', {
    width: accepted.w, height: accepted.h, ssim: 1,
    note: accepted.s < 1 ? 'PNG는 무손실이라 해상도를 줄여 맞췄습니다 (JPG로 바꾸면 해상도를 더 지킬 수 있어요)' : 'PNG 무손실 최적화',
  });
}
