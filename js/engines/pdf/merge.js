/* ============================================================
   merge.js — PDF 합치기 엔진 (UI 없음, 워커 안에서만 import)
   mergePdf(null, { sources: [{ file, kind: 'pdf'|'image', name }], size, orient, margin }, ctx) → result
   ------------------------------------------------------------
   · PDF: pdf-lib copyPages 로 모든 쪽을 그대로 옮긴다 (래스터화 없음, 글자 선택·검색 그대로).
          암호(보안) PDF 는 손대지 않고 빼고(skipped) 나머지로 계속 — 화면이 안내.
   · 사진: 한 장 = 한 쪽. 다시 압축하지 않는다(용량은 다음 단계 [압축]에서 줄인다).
            JPG                 → 파일 바이트 그대로 (메타데이터만 무손실 제거, 회전값은 그리는 행렬로 반영)
            그 밖(PNG·HEIC·WebP·BMP·TIFF…) → 풀어서 픽셀 그대로 무손실(Flate). PDF 는 HEIC·WebP 를 담을 수 없어서
                                    한 번 풀어야 하지만, 푼 픽셀은 하나도 바꾸지 않는다.
          투명한 부분은 흰 종이 위에 놓인 모습 그대로 흰색으로 채운다.
     size   'a4'  = A4 (orient: 'auto' 사진 비율 따라 · 'portrait' 세로 · 'landscape' 가로), 여백 안에 비율대로 맞춰 가운데
            'fit' = 사진 크기 그대로 (1px = 0.75pt, 96dpi) + 여백. 방향은 사진을 따른다
     margin 'none' 0 · 'narrow' 10mm · 'normal' 20mm
   result: { kind: 'merged', bytes, size, pages, counts: [소스마다 쪽 수, 뺀 것은 0], skipped: [소스 번호], lost }
   파일은 워커 안에서만 다뤄지며 어디로도 전송되지 않습니다.
   ============================================================ */

import { loadPdfLib } from './libs.js';
import { openPdf } from './open.js';
import { prepareSource, copyInto, tidy, saveDoc } from './copy.js';
import { detectType, stripMetadata } from '../../shared/image/metadata.js';
import { decodeSource, closeSource, drawToCanvas, flattenOn } from '../../shared/image/pipeline.js';
import { t as tx } from '../../i18n/index.js';

const A4 = [595.28, 841.89];                  // pt (210 × 297 mm)
const MM = 72 / 25.4;
const PX = 0.75;                              // '사진 크기 그대로': 1px = 0.75pt (96dpi)
const MAX_PAGE = 14400;                       // PDF 쪽 한 변 최대(pt) — 넘으면 비율대로 줄인다
export const MARGINS = { none: 0, narrow: 10, normal: 20 };   // mm

export async function mergePdf(_file, o, ctx) {
  const sources = o.sources || [];
  if (!sources.length) throw new Error(tx('merge.007'));
  ctx.progress(tx('pdf.005'), 0.02);
  const L = await loadPdfLib();
  const out = await L.PDFDocument.create({ updateMetadata: false });
  const page = {
    size: o.size === 'fit' ? 'fit' : 'a4',
    orient: ['portrait', 'landscape'].includes(o.orient) ? o.orient : 'auto',
    margin: (MARGINS[o.margin] ?? MARGINS.narrow) * MM,
  };
  const counts = [];
  const skipped = [];
  const lost = { links: 0, forms: false, outlines: false };
  const quiet = { progress() {} };

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const at = (f) => 0.04 + 0.88 * ((i + f) / sources.length);
    const label = tx('merge.002', { p: i + 1, n: sources.length });
    ctx.progress(label, at(0));
    const bytes = new Uint8Array(await s.file.arrayBuffer());
    if (s.kind === 'pdf') {
      let doc, L2;
      try {
        ({ doc, L: L2 } = await openPdf(bytes, quiet, { encrypted: () => tx('merge.001', { name: s.name }) }));
      } catch (err) {
        // 암호 PDF 는 빼고 계속 (화면이 '빼고 합쳤어요' 안내)
        if (err && err.encrypted) { skipped.push(i); counts.push(0); continue; }
        if (err && err.notice) throw err;
        throw new Error(tx('merge.003', { name: s.name, e: (err && err.message) || '' }));
      }
      const prep = prepareSource(L2, doc);
      lost.forms ||= prep.lost.forms;
      lost.outlines ||= prep.lost.outlines;
      lost.links += prep.lost.links;
      const n = doc.getPageCount();
      lost.links += await copyInto(L, out, doc, [...Array(n).keys()]);
      counts.push(n);
    } else {
      await addPhotoPage(L, out, bytes, page, s.name, (f) => ctx.progress(`${label} · ${tx('merge.004')}`, at(f)));
      counts.push(1);
    }
  }
  if (!out.getPageCount()) throw Object.assign(new Error(tx('merge.008')), { notice: true });

  ctx.progress(tx('merge.005'), 0.94);
  await out.flush();
  tidy(L, out);
  const result = await saveDoc(out);
  return {
    kind: 'merged', bytes: result, size: result.length, mime: 'application/pdf', ext: 'pdf',
    pages: out.getPageCount(), counts, skipped, lost,
  };
}

/* ---------- 사진 한 장 → 한 쪽 (다시 압축하지 않음) ---------- */
async function addPhotoPage(L, out, bytes, page, name, report) {
  const type = detectType(bytes.subarray(0, 4096));
  let ref = null, w = 0, h = 0, orientation = 1;

  if (type === 'jpeg') {
    // JPG 는 바이트 그대로 (EXIF·주석만 무손실 제거). 회전값은 그리는 행렬로.
    const st = stripMetadata('jpeg', bytes);
    try {
      const img = await out.embedJpg(st.bytes || bytes);
      ref = img.ref; w = img.width; h = img.height; orientation = st.orientation || 1;
    } catch { ref = null; }   // pdf-lib 가 못 읽는 JPG(산술 부호화 등)는 아래에서 풀어서 무손실로
  }

  if (!ref) {
    let source;
    try { source = await decodeSource(bytes, type); }   // 회전값 반영해서 연다
    catch (err) { throw Object.assign(new Error(tx('merge.006', { name })), { network: !!(err && err.network) }); }
    let img;
    try {
      w = source.width; h = source.height;
      img = source instanceof ImageData ? source : drawToCanvas(source, w, h).getContext('2d').getImageData(0, 0, w, h);
    } finally {
      if (!(source instanceof ImageData)) closeSource(source);
    }
    flattenOn(img.data);   // 투명 → 흰 종이색
    report(0.4);
    ref = rawImage(L, out, img, isGray(img.data));
  }
  report(1);

  // 보이는 방향 기준 가로·세로 (EXIF 5~8 은 90° 돌아간 것)
  const turned = orientation >= 5 && orientation <= 8;
  const dw = turned ? h : w, dh = turned ? w : h;
  const m = page.margin;
  let pw, ph, W, H;
  if (page.size === 'fit') {
    // 사진 크기 그대로: 쪽 = 사진 + 여백 (너무 크면 PDF 한도 안으로 비율대로 줄임)
    const s = Math.min(PX, (MAX_PAGE - 2 * m) / dw, (MAX_PAGE - 2 * m) / dh);
    W = dw * s; H = dh * s;
    pw = W + 2 * m; ph = H + 2 * m;
  } else {
    const landscape = page.orient === 'landscape' || (page.orient === 'auto' && dw > dh);
    [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const s = Math.min((pw - 2 * m) / dw, (ph - 2 * m) / dh);
    W = dw * s; H = dh * s;
  }
  const x = (pw - W) / 2, y = (ph - H) / 2;

  const pg = out.addPage([pw, ph]);
  const xo = pg.node.newXObject('Im', ref);
  pg.pushOperators(
    L.pushGraphicsState(),
    L.concatTransformationMatrix(...matrix(orientation, x, y, W, H)),
    L.drawObject(xo),
    L.popGraphicsState(),
  );
}

/**
 * 그림 단위 정사각형 → 쪽 위 (x, y, W, H) 칸. EXIF 회전·뒤집기 8가지를 행렬로 반영
 * (픽셀을 다시 쓰지 않으므로 무손실).
 */
function matrix(o, x, y, W, H) {
  switch (o) {
    case 2: return [-W, 0, 0, H, x + W, y];
    case 3: return [-W, 0, 0, -H, x + W, y + H];
    case 4: return [W, 0, 0, -H, x, y + H];
    case 5: return [0, -H, -W, 0, x + W, y + H];
    case 6: return [0, -H, W, 0, x, y + H];
    case 7: return [0, H, W, 0, x, y];
    case 8: return [0, H, -W, 0, x + W, y];
    default: return [W, 0, 0, H, x, y];
  }
}

/** 무손실: 픽셀을 그대로 Flate 로 (흑백이면 1채널) */
function rawImage(L, out, img, gray) {
  const { width, height, data } = img;
  const comps = gray ? 1 : 3;
  const px = new Uint8Array(width * height * comps);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    if (gray) px[j++] = data[i];
    else { px[j++] = data[i]; px[j++] = data[i + 1]; px[j++] = data[i + 2]; }
  }
  const stream = out.context.flateStream(px, {
    Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
    ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8,
  });
  return out.context.register(stream);
}

function isGray(d) {
  for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) return false;
  return true;
}
