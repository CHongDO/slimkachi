/* ============================================================
   imageCompress.js — 사진 용량 줄이기 엔진 (UI 없음, 워커 안에서만 import)
   ------------------------------------------------------------
   처리 순서
   ① 메타데이터 무손실 제거 (후보 1)
   ② 픽셀 디코딩 (회전 반영, 필요 시 해상도 축소)
   ③ 효율 좋은 인코더로 재인코딩 — 품질을 이분 탐색하며 원본과의
      SSIM 이 기준선 이상인 가장 낮은 품질(=가장 작은 파일)을 찾음 (후보 2)
   ④ 후보 중 가장 작은 것 선택. 원본보다 작지 않으면 원본 유지.
   저장 형식이 바뀌면(사용자가 고름 / BMP·HEIC 처럼 원본 형식으로 못 저장) 위 대신 convertImage:
   디코딩 → (JPG 면 투명 부분 배경색) → PNG 는 무손실 최적화, 손실 형식은 화질 기준 품질 탐색.
   이때는 결과가 원본보다 커도 변환 결과를 돌려준다(grew 표시).
   compressImage(file, { mode, format, maxDim, bg }, ctx) → result
   공용 단계(디코딩·인코더·화질 측정)는 js/shared/image/ 에 있습니다.
   ============================================================ */

import { detectType, stripMetadata, isAnimated, outputFormat } from '../shared/image/metadata.js';
import { optimisePng, encode } from '../shared/image/codecs.js';
import {
  TARGETS, MIME, EXT, QUALITY_RANGE, targetFor, decodeImage, makeThumb, prepareForFormat, searchQuality,
  score, packResult, parseColor, convInfo,
} from '../shared/image/pipeline.js';

const MIN_LOSSY_GAIN = 0.05; // 손실 재인코딩은 최소 5% 이상 줄어야 채택

export async function compressImage(file, options, ctx) {
  const mode = TARGETS[options.mode] ? options.mode : 'size';
  const src = new Uint8Array(await file.arrayBuffer());
  const type = detectType(src);
  if (type === 'svg' || type === 'psd') throw Object.assign(new Error('이 형식은 아직 지원하지 않습니다'), { notice: true });
  const format = outputFormat(options.format, type);
  if (format !== type) return convertImage(src, type, format, mode, options, ctx);

  ctx.progress('메타데이터 정리', 0.03);
  const stripped = stripMetadata(type, src);

  const candidates = [];
  const original = { size: src.length, format: type };

  // 움직이는 이미지(APNG, 애니메이션 WebP)는 재인코딩하면 움직임이 사라지므로 메타데이터만 제거
  if (stripped.animated) {
    if (stripped.bytes) candidates.push({ kind: 'stripped', bytes: stripped.bytes, format: type, ssim: 1 });
    return { ...finish(original, candidates, null, '움직이는 이미지라 메타데이터만 제거했습니다'), srcFormat: type, converted: false };
  }

  ctx.progress('이미지 해석', 0.06);
  const decoded = await decodeImage(src, type, options.maxDim || 0);
  const img = decoded.img;
  const resized = decoded.resized;
  const dims = { width: img.width, height: img.height, origWidth: decoded.origWidth, origHeight: decoded.origHeight };
  makeThumb(img).then(ctx.thumb, () => {});

  // 해상도를 줄이지 않았다면 '메타데이터만 제거한 원본'도 후보 (화질 손실 0)
  if (!resized && stripped.bytes) {
    candidates.push({ kind: 'stripped', bytes: stripped.bytes, format: type, ssim: 1, ...dims });
  }

  const { opaque } = prepareForFormat(img, type, format);

  let note = '';
  if (format === 'png') {
    // PNG 유지: 무손실 최적화 (픽셀 그대로)
    ctx.progress('PNG 무손실 최적화', 0.15);
    const level = img.width * img.height > 4_000_000 ? 1 : 2;
    const usableBytes = !resized && stripped.orientation === 1;
    const input = usableBytes ? (stripped.bytes || src) : img;
    const bytes = await optimisePng(input, level);
    candidates.push({ kind: 'lossless', bytes, format: 'png', ssim: 1, ...dims });
  } else {
    const { target, scale } = targetFor(mode, img);
    const report = (label, f) => ctx.progress(label, 0.12 + 0.85 * f);
    const lossy = await searchQuality(format, img, mode, target, opaque, scale, report);
    if (lossy) candidates.push({ kind: 'lossy', ...lossy, format, ...dims });
    else note = '기준 화질을 유지하면서 더 줄일 수 없었습니다';
  }

  if (resized) note = note || `해상도를 ${img.width}×${img.height}로 줄였습니다`;
  return { ...finish(original, candidates, dims, note), srcFormat: type, converted: false };
}

/** 저장 형식 변환: 원본보다 커져도 변환 결과를 쓴다 */
async function convertImage(src, type, format, mode, options, ctx) {
  const animated = isAnimated(type, src);
  ctx.progress('이미지 해석', 0.06);
  const decoded = await decodeImage(src, type, options.maxDim || 0);
  const img = decoded.img;
  const dims = { width: img.width, height: img.height, origWidth: decoded.origWidth, origHeight: decoded.origHeight };
  makeThumb(img).then(ctx.thumb, () => {});
  const { opaque, filled } = prepareForFormat(img, type, format, parseColor(options.bg));

  let r;
  if (format === 'png') {
    ctx.progress('PNG 무손실 저장', 0.15);
    const bytes = await optimisePng(img, img.width * img.height > 4_000_000 ? 1 : 2);
    r = packResult('lossless', bytes, 'png', { ssim: 1, note: 'PNG 무손실 저장 (화질 변화 없음)' });
  } else {
    const { target, scale } = targetFor(mode, img);
    const report = (label, f) => ctx.progress(label, 0.12 + 0.85 * f);
    const lossy = await searchQuality(format, img, mode, target, opaque, scale, report);
    if (lossy) {
      r = packResult('lossy', lossy.bytes, format, { quality: lossy.quality, ssim: lossy.ssim, ssimLow: lossy.ssimLow });
    } else {
      // 기준을 넘는 품질이 없으면(드묾) 가장 높은 품질로 저장
      const q = QUALITY_RANGE[format][1];
      ctx.progress(`최고 품질로 저장 (품질 ${q})`, 0.9);
      const bytes = await encode(format, img, q, mode);
      const s = await score(format, img, bytes, opaque, scale);
      r = packResult('lossy', bytes, format, { quality: q, ssim: s.mean, ssimLow: s.low });
    }
  }
  if (decoded.resized) r.note = [r.note, `해상도를 ${img.width}×${img.height}로 줄였습니다`].filter(Boolean).join(' · ');
  return {
    ...r, ...dims,
    ...convInfo(type, format, { srcSize: src.length, size: r.size, filled, bg: options.bg, animated }),
  };
}

function finish(original, candidates, dims, note) {
  // 무손실 후보(메타데이터 제거, PNG 최적화)는 조금이라도 작으면 채택.
  // 손실 재인코딩은 화질을 한 번 더 깎는 일이라, 무손실 최선보다 MIN_LOSSY_GAIN 이상
  // 줄어들 때만 채택한다. (이미 최적화된 사진을 1~2% 위해 다시 깎지 않음)
  let best = null;
  for (const c of candidates) {
    if (c.kind === 'lossy') continue;
    if (c.bytes.length < original.size && (!best || c.bytes.length < best.bytes.length)) best = c;
  }
  const losslessSize = best ? best.bytes.length : original.size;
  for (const c of candidates) {
    if (c.kind === 'lossy' && c.bytes.length <= losslessSize * (1 - MIN_LOSSY_GAIN)) best = c;
  }
  if (!best) {
    let why = '이미 충분히 최적화된 파일이라 원본을 유지했습니다';
    if (candidates.some((c) => c.kind === 'lossy')) why = '이미 잘 압축된 파일이라 화질 보호를 위해 원본을 유지했습니다';
    else if (note && !note.startsWith('해상도')) why = `${note} — 원본을 유지했습니다`;
    return {
      kind: 'original', size: original.size, mime: MIME[original.format], ext: EXT[original.format],
      ssim: 1, ...(dims || {}), note: why,
    };
  }
  return {
    kind: best.kind,
    bytes: best.bytes,
    size: best.bytes.length,
    mime: MIME[best.format],
    ext: EXT[best.format],
    quality: best.quality,
    ssim: best.ssim,
    ssimLow: best.ssimLow,
    width: best.width, height: best.height, origWidth: best.origWidth, origHeight: best.origHeight,
    note: best.kind === 'stripped' ? '메타데이터만 제거했습니다 (화질 변화 없음)'
      : best.kind === 'lossless' ? (note || '무손실 최적화 (화질 변화 없음)') : note,
  };
}
