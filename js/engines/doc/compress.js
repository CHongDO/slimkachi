/* ============================================================
   compress.js — 문서 용량 줄이기 엔진 (HWP·HWPX·DOCX·PPTX·XLSX, 워커 전용, UI 없음)
   ------------------------------------------------------------
   원리: 문서 안에 든 사진(JPG·PNG)만 꺼내 같은 형식으로 다시 압축하고 제자리에 넣는다.
     · 글자·표·서식·구조·다른 항목은 건드리지 않는다. 형식 변환(HWP→PDF 등)도 하지 않는다.
     · 사진 압축은 사진 엔진(compressImage, 자동 화질 탐색)을 그대로 쓴다. 형식은 원본과 같게(format 'same').
       해상도는 모드별 긴 변 상한으로만 줄인다 — 문서는 표시 크기를 따로 저장하므로 보이는 크기는 그대로.
     · 결과 사진이 원본보다 작을 때만 바꾼다. EMF·WMF·SVG 같은 벡터 그림·GIF·BMP 등은 그대로.
     · 회전 정보가 있는 JPG·CMYK JPG 는 그대로 둔다(뷰어마다 다르게 보일 수 있어서).
     · 사진은 한 장씩 처리하고 바로 놓아준다(메모리).
     · 문서 전체가 거의 안 줄면(3% 미만) 원본 유지.
   compressDoc(file, { mode }, ctx) → result (+ images 통계, 가장 큰 사진 전후 비교용 Blob)
   ============================================================ */

import { openDoc, photoType } from './open.js';
import { patchZip } from './zip.js';
import { writeCfb } from './cfb.js';
import { compressImage } from '../imageCompress.js';
import { stripMetadata } from '../../shared/image/metadata.js';
import { t as tx } from '../../i18n/index.js';

const MAX_EDGE = { size: 2000, balanced: 2560, quality: 0 };   // 0 = 줄이지 않음
const MIN_GAIN = 0.03;
const MIME = {
  hwp: 'application/x-hwp', hwpx: 'application/hwp+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const IMG_MIME = { jpeg: 'image/jpeg', png: 'image/png' };

/** JPEG 성분 수 (SOF). 4 = CMYK */
function jpegComponents(b) {
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) return 0;
    const m = b[p + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
    if (m === 0xd9 || m === 0xda) return 0;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[p + 9];
    p += 2 + len;
  }
  return 0;
}

/** 사진 한 장을 같은 형식으로 줄인다. 못 줄이면 null */
async function shrink(bytes, mode, ctx) {
  const t = photoType(bytes);
  if (!t) return null;
  if (t === 'jpeg') {
    if (stripMetadata('jpeg', bytes).orientation !== 1) return null;
    if (jpegComponents(bytes) === 4) return null;
  }
  const r = await compressImage(new Blob([bytes], { type: IMG_MIME[t] }), { mode, format: 'same', maxDim: MAX_EDGE[mode] ?? 2000 }, ctx);
  if (!r.bytes || r.bytes.length >= bytes.length) return null;
  return { bytes: r.bytes, type: t, width: r.width, height: r.height, origWidth: r.origWidth, origHeight: r.origHeight };
}

export async function compressDoc(file, options, ctx) {
  const mode = MAX_EDGE[options.mode] !== undefined ? options.mode : 'size';
  const src = new Uint8Array(await file.arrayBuffer());
  ctx.progress(tx('doc.001'), 0.03);
  const doc = await openDoc(src, file.name);
  const ext = doc.ext;
  const list = doc.images;
  const quiet = { progress: () => {}, thumb: () => {} };
  const repl = new Map();
  let compressed = 0, photos = 0, best = null;

  for (let i = 0; i < list.length; i++) {
    const im = list[i];
    ctx.progress(tx('doc.002', { p: i + 1, listCount: list.length }), 0.05 + 0.88 * (i / Math.max(1, list.length)));
    let data, deflated = false;
    if (doc.container === 'zip') data = doc.read(im.key);
    else ({ data, deflated } = doc.readHwp(im.key));
    if (!photoType(data)) continue;
    photos++;
    let r = null;
    try { r = await shrink(data, mode, quiet); } catch (err) { console.warn('사진 하나를 건너뜀:', im.name, err && err.message); }
    if (!r) continue;
    compressed++;
    if (doc.container === 'zip') repl.set(im.key, r.bytes);
    else repl.set(im.key, deflated ? doc.fflate.deflateSync(r.bytes, { level: 9 }) : r.bytes);
    // 결과 화면 비교용: 원본이 가장 큰 사진 하나만 기억
    if (!best || data.length > best.before.length) best = { name: im.name, before: data, after: r.bytes, type: r.type, ...r };
    data = null;   // 한 장씩 놓아준다
  }

  ctx.progress(tx('doc.003'), 0.95);
  let out = src;
  if (repl.size) {
    out = doc.container === 'zip'
      ? patchZip(src, doc.zip, repl, doc.fflate, { store: ext === 'hwpx' ? ['mimetype'] : [] })
      : writeCfb(doc.cfb, repl);
  }

  const images = { total: list.length, photos, compressed };
  const compare = best ? {
    name: best.name,
    before: new Blob([best.before], { type: IMG_MIME[best.type] }),
    after: new Blob([best.after], { type: IMG_MIME[best.type] }),
    beforeSize: best.before.length, afterSize: best.after.length,
    width: best.width, height: best.height, origWidth: best.origWidth, origHeight: best.origHeight,
  } : null;

  if (!repl.size || out.length > src.length * (1 - MIN_GAIN)) {
    return {
      kind: 'original', size: src.length, mime: MIME[ext], ext, images, compare: null,
      note: tx('doc.004'),
    };
  }
  return {
    kind: 'lossy', bytes: out, size: out.length, mime: MIME[ext], ext, images, compare,
    note: tx('doc.005', { compressed }),
  };
}
