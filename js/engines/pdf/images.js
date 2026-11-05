/* ============================================================
   images.js — PDF 안 이미지 재압축 (워커 전용)
   ------------------------------------------------------------
   이미지 XObject 만 골라서
     ① 픽셀로 풀고 (JPEG=DCTDecode 는 브라우저 디코더, Flate 는 직접 inflate)
     ② 페이지에 그려지는 크기보다 과하게 크면 적정 해상도(ppi)로 줄이고
     ③ 사진 엔진과 같은 공용 인코더(MozJPEG) + SSIM 화질 탐색으로 다시 저장해
     ④ 화질 기준을 통과하고 충분히 작아진 경우에만 원래 객체 자리에 바꿔 넣는다.
   글자·벡터·폰트·인라인 이미지·마스크(SMask)는 건드리지 않는다.
   색이 바뀔 위험이 있는 이미지(CMYK, Indexed, 특수 색공간, Decode 배열,
   1/16비트, JBIG2·CCITT·JPX)는 그대로 둔다.
   ============================================================ */

import { searchQuality, targetFor, resizeTo, drawToCanvas } from '../../shared/image/pipeline.js';
import { t as tx } from '../../i18n/index.js';

/** 모드별 목표 해상도(ppi). 그려지는 크기 기준으로 이것의 1.5배를 넘으면 줄인다. */
const PPI = { size: 150, balanced: 200, quality: 300 };
const DOWNSAMPLE_OVER = 1.5;
const MIN_GAIN = 0.05;         // 이미지마다 5% 이상 줄어야 교체
const MIN_PIXELS = 64 * 64;    // 너무 작은 이미지는 다시 저장해도 이득이 없다
const MIN_BYTES = 4 * 1024;

export async function optimiseImages(L, doc, mode, sizes, report) {
  const { PDFName, PDFRawStream, PDFArray, PDFRef, PDFNumber } = L;
  const ctx = doc.context;
  const N = (s) => PDFName.of(s);
  const stats = { images: 0, recompressed: 0, downsampled: 0, before: 0, after: 0 };

  // 마스크로 쓰이는 이미지는 손대지 않는다 (가장자리 품질·투명도 보호)
  const masks = new Set();
  const images = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const sub = obj.dict.lookup(N('Subtype'));
    if (!sub || sub.toString() !== '/Image') continue;
    for (const k of ['SMask', 'Mask']) {
      const m = obj.dict.get(N(k));
      if (m instanceof PDFRef) masks.add(m.tag);
    }
    images.push([ref, obj]);
  }
  const todo = images.filter(([ref]) => !masks.has(ref.tag));
  stats.images = todo.length;

  for (let idx = 0; idx < todo.length; idx++) {
    const [ref, obj] = todo[idx];
    const label = tx('pdfimg.001', { p: idx + 1, todoCount: todo.length });
    report(tx('pdfimg.002', { label }), idx / todo.length);
    let plan;
    try { plan = analyse(L, ctx, obj); } catch { plan = null; }
    if (!plan) continue;

    let img;
    try { img = await decodePixels(plan, obj.contents); } catch (e) { console.warn('decode', e); continue; }
    if (!img) continue;

    // 그려지는 크기 대비 해상도
    let resized = false;
    const use = sizes.get(ref.tag);
    if (use && use.w > 0 && use.h > 0) {
      const ppiX = plan.width / (use.w / 72);
      const ppiY = plan.height / (use.h / 72);
      const s = Math.max(PPI[mode] / ppiX, PPI[mode] / ppiY);
      if (s < 1 / DOWNSAMPLE_OVER) {
        const w = Math.max(1, Math.round(plan.width * s));
        const h = Math.max(1, Math.round(plan.height * s));
        img = await resizeTo(img, w, h);
        resized = true;
      }
    }

    // DeviceRGB 인데 사실상 흑백(스캔 문서 등)이면 1채널로 저장
    const gray = plan.comps === 1 || (plan.csName === '/DeviceRGB' && isNeutral(img.data));
    const { target, scale } = targetFor(mode, img);
    const sub = (t, f) => report(`${label} ${t}`, (idx + f) / todo.length);
    let found;
    try {
      found = await searchQuality('jpeg', img, mode, target, true, scale, (t, f) => sub(tx('pdfimg.003'), f), { gray });
    } catch (e) { console.warn('encode', e); continue; }
    if (!found) continue;
    // 안전장치: 새 JPEG 의 색 성분 수가 PDF 에 적힐 색공간과 맞지 않으면 바꾸지 않는다
    if (jpegComponents(found.bytes) !== (gray ? 1 : 3)) continue;
    const oldSize = obj.contents.length;
    if (found.bytes.length > oldSize * (1 - MIN_GAIN)) continue;

    const dict = obj.dict.clone(ctx);
    dict.set(N('Filter'), N('DCTDecode'));
    dict.delete(N('DecodeParms'));
    dict.delete(N('Metadata'));
    dict.set(N('Width'), PDFNumber.of(img.width));
    dict.set(N('Height'), PDFNumber.of(img.height));
    dict.set(N('BitsPerComponent'), PDFNumber.of(8));
    if (gray && plan.comps === 3) dict.set(N('ColorSpace'), N('DeviceGray'));
    ctx.assign(ref, PDFRawStream.of(dict, found.bytes));

    stats.recompressed++;
    if (resized) stats.downsampled++;
    stats.before += oldSize;
    stats.after += found.bytes.length;
  }
  report(tx('pdfimg.004'), 1);
  return stats;

  /* ---- 이 이미지를 안전하게 다시 저장할 수 있는지 판단 ---- */
  function analyse(L2, c, obj) {
    const d = obj.dict;
    const num = (k) => { const v = d.lookup(N(k)); return v && v.asNumber ? v.asNumber() : NaN; };
    const width = num('Width'), height = num('Height');
    if (!(width > 0 && height > 0) || width * height < MIN_PIXELS || obj.contents.length < MIN_BYTES) return null;
    if (width * height > 80_000_000) return null; // 메모리 보호
    const im = d.lookup(N('ImageMask'));
    if (im && im.toString() === 'true') return null;
    if (d.has(N('Decode'))) return null;
    if (d.lookup(N('Mask')) instanceof PDFArray) return null; // 색 키 마스크: 정확한 색이 필요

    let filter = d.lookup(N('Filter'));
    if (filter instanceof PDFArray) {
      if (filter.size() !== 1) return null;
      filter = filter.lookup(0);
    }
    const f = filter ? filter.toString() : '';
    if (f !== '/DCTDecode' && f !== '/FlateDecode') return null;

    const cs = d.lookup(N('ColorSpace'));
    let comps = 0, csName = '';
    if (cs && !(cs instanceof PDFArray)) {
      csName = cs.toString();
      if (csName === '/DeviceRGB') comps = 3;
      else if (csName === '/DeviceGray') comps = 1;
    } else if (cs instanceof PDFArray && cs.size() === 2 && cs.lookup(0).toString() === '/ICCBased') {
      const icc = cs.lookup(1);
      const n = icc && icc.dict ? icc.dict.lookup(N('N')) : null;
      const nn = n && n.asNumber ? n.asNumber() : 0;
      if (nn === 1 || nn === 3) { comps = nn; csName = '/ICCBased'; }
    }
    if (!comps) return null; // CMYK·Indexed·Lab·Separation 등은 그대로

    let parms = d.lookup(N('DecodeParms'));
    if (parms instanceof PDFArray) parms = parms.lookup(0);
    const pnum = (k) => { const v = parms && parms.lookup ? parms.lookup(N(k)) : null; return v && v.asNumber ? v.asNumber() : undefined; };

    if (f === '/DCTDecode') {
      if (parms && parms.lookup && parms.lookup(N('ColorTransform'))) return null;
      const jc = jpegComponents(obj.contents);
      if (jc !== comps) return null;
      return { kind: 'jpeg', width, height, comps, csName };
    }
    if (num('BitsPerComponent') !== 8) return null;
    const predictor = pnum('Predictor') || 1;
    if (predictor !== 1 && predictor < 10) return null; // TIFF 예측자는 지원 안 함
    if (predictor >= 10) {
      if ((pnum('Colors') || 1) !== comps || (pnum('BitsPerComponent') || 8) !== 8 || (pnum('Columns') || 1) !== width) return null;
    }
    return { kind: 'flate', width, height, comps, csName, predictor };
  }
}

/* ---------- 픽셀 풀기 ---------- */

async function decodePixels(plan, bytes) {
  if (plan.kind === 'jpeg') {
    // PDF 는 JPEG 안의 EXIF 회전을 무시하므로 APP1 을 지우고 푼다. 색 변환도 하지 않는다.
    const clean = dropApp1(bytes);
    const bmp = await createImageBitmap(new Blob([clean], { type: 'image/jpeg' }), {
      colorSpaceConversion: 'none', premultiplyAlpha: 'none',
    });
    if (bmp.width !== plan.width || bmp.height !== plan.height) { bmp.close(); return null; }
    const c = drawToCanvas(bmp, bmp.width, bmp.height);
    bmp.close();
    return c.getContext('2d').getImageData(0, 0, plan.width, plan.height);
  }
  const raw = await inflate(bytes);
  const { width: w, height: h, comps } = plan;
  const rowBytes = w * comps;
  let px;
  if (plan.predictor >= 10) px = unpredictPng(raw, rowBytes, comps, h);
  else px = raw;
  if (!px || px.length < rowBytes * h) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  if (comps === 3) {
    for (let s = 0, d = 0, n = w * h; d < n * 4; s += 3, d += 4) {
      out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = 255;
    }
  } else {
    for (let s = 0, d = 0, n = w * h; s < n; s++, d += 4) {
      const v = px[s];
      out[d] = v; out[d + 1] = v; out[d + 2] = v; out[d + 3] = 255;
    }
  }
  return new ImageData(out, w, h);
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** PNG 예측자(Predictor 10~15) 되돌리기 */
function unpredictPng(src, rowBytes, bpp, h) {
  const stride = rowBytes + 1;
  if (src.length < stride * h) return null;
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const type = src[y * stride];
    const s = y * stride + 1;
    const o = y * rowBytes;
    const up = o - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = src[s + x];
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0;
      let v;
      switch (type) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      out[o + x] = v & 255;
    }
  }
  return out;
}

/* ---------- JPEG 헤더 ---------- */

/** SOF 의 색 성분 수 (1=흑백, 3=컬러, 4=CMYK). 못 찾으면 0 */
function jpegComponents(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return 0;
  let i = 2;
  while (i + 4 < u8.length) {
    if (u8[i] !== 0xff) { i++; continue; }
    const m = u8[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return u8[i + 9] || 0;
    if (m === 0xda) return 0;
    i += 2 + len;
  }
  return 0;
}

/** APP1(EXIF/XMP) 세그먼트 제거 — 회전 정보 때문에 픽셀이 돌아가지 않도록 */
function dropApp1(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return u8;
  const parts = [u8.subarray(0, 2)];
  let i = 2;
  while (i + 4 < u8.length && u8[i] === 0xff) {
    const m = u8[i + 1];
    if (m === 0xda) break;
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (m !== 0xe1) parts.push(u8.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (parts.length === 1 && i === 2) return u8;
  parts.push(u8.subarray(i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 모든 픽셀이 무채색(R≈G≈B)인지 */
function isNeutral(d) {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.abs(r - g) > 3 || Math.abs(g - b) > 3 || Math.abs(r - b) > 3) return false;
  }
  return true;
}
