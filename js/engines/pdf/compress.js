/* ============================================================
   compress.js — PDF 용량 줄이기 엔진 (UI 없음, 워커 안에서만 import)
   compressPdf(file, { mode }, ctx) → result
   ------------------------------------------------------------
   처리 순서
   ① 암호 확인 — 암호(보안)가 걸린 PDF는 손대지 않고 안내
   ② 이미지 재압축 (pdf-lib) — 이미지 객체만 골라 공용 인코더 + SSIM
      화질 탐색으로 다시 저장, 그려지는 크기보다 과하게 크면 다운샘플 (images.js)
   ③ 무손실 정리 (pdf-lib) — 똑같은 스트림 합치기, 화면에 안 보이는 부가 데이터
      (PieceInfo 편집 정보, 페이지 미리보기 Thumb, XMP 메타데이터) 제거
   ④ 무손실 재작성 (qpdf) — 객체 스트림, Flate 최고 압축, 안 쓰는 리소스·객체 제거
   ⑤ 원본보다 거의 안 줄면 원본 유지
   글자·벡터(내용 스트림, 폰트)는 바꾸지 않고, 페이지를 그림으로 바꾸지도 않는다.
   파일은 워커 안에서만 다뤄지며 어디로도 전송되지 않습니다.
   ============================================================ */

import { TARGETS } from '../../shared/image/pipeline.js';
import { loadPdfLib, runQpdf } from './libs.js';
import { measureImageUse } from './content.js';
import { optimiseImages } from './images.js';
import { t as tx } from '../../i18n/index.js';

const MIN_GAIN = 0.03; // 3% 도 안 줄면 원본 유지
const QPDF_ARGS = [
  '--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9',
  '--decode-level=generalized', '--remove-unreferenced-resources=yes',
];
// 문구는 처리 때마다 그 언어로 만든다 (워커는 시작한 뒤에 언어를 받음)
const ENCRYPTED = () => tx('pdf.001');
const KEPT = () => tx('pdf.002');
/** 오류가 아니라 '처리할 수 없는 파일' 안내 (화면에서 경고색으로 표시) */
const notice = (message) => Object.assign(new Error(message), { notice: true });

export async function compressPdf(file, o, ctx) {
  const mode = TARGETS[o.mode] ? o.mode : 'size';
  ctx.progress(tx('pdf.003'), 0.02);
  const src = new Uint8Array(await file.arrayBuffer());
  if (!isPdf(src)) throw new Error(tx('pdf.004'));

  ctx.progress(tx('pdf.005'), 0.04);
  const L = await loadPdfLib();
  const load = (bytes) => L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });

  let doc = null;
  try { doc = await load(src); } catch (e) { console.warn('pdf-lib load', e); }
  if (doc && doc.isEncrypted) throw notice(ENCRYPTED());
  if (!doc) {
    // 구조가 깨진 파일: qpdf 로 먼저 복구해 본다
    if (hasEncryptKey(src)) throw notice(ENCRYPTED());
    ctx.progress(tx('pdf.006'), 0.06);
    try { doc = await load(await runQpdf(src, ['--object-streams=disable'])); }
    catch { throw new Error(tx('pdf.007')); }
    if (doc.isEncrypted) throw notice(ENCRYPTED());
  }
  const pages = doc.getPageCount();

  ctx.progress(tx('pdf.008'), 0.08);
  const sizes = measureImageUse(L, doc);

  const stats = await optimiseImages(L, doc, mode, sizes, (label, f) => ctx.progress(label, 0.1 + 0.75 * f));

  ctx.progress(tx('pdf.009'), 0.86);
  const deduped = dedupeStreams(L, doc);
  stripExtras(L, doc);

  ctx.progress(tx('pdf.010'), 0.9);
  const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  let out;
  try {
    out = await runQpdf(saved, QPDF_ARGS);
  } catch (e) {
    console.warn(e);
    out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  }

  // 안전 확인: 결과를 다시 열어 쪽수가 같은지
  ctx.progress(tx('ws.140'), 0.97);
  let ok = false;
  try { ok = (await load(out)).getPageCount() === pages; } catch { ok = false; }
  if (!ok) {
    // pdf-lib 재작성이 의심스러우면 원본에 qpdf 무손실만 적용
    try {
      out = await runQpdf(src, QPDF_ARGS);
      stats.recompressed = 0; stats.downsampled = 0;
    } catch { out = src; }
  }

  if (out.length > src.length * (1 - MIN_GAIN)) {
    return { kind: 'original', size: src.length, mime: 'application/pdf', ext: 'pdf', pages, note: KEPT(), stats };
  }
  const lossless = stats.recompressed === 0;
  const note = [];
  if (stats.recompressed) {
    note.push(tx('pdf.011', { recompressed: stats.recompressed }) + (stats.downsampled ? tx('pdf.012', { downsampled: stats.downsampled }) : ''));
  } else {
    note.push(tx('pdf.013'));
  }
  if (deduped) note.push(tx('pdf.014', { deduped }));
  return {
    kind: lossless ? 'lossless' : 'lossy', bytes: out, size: out.length,
    mime: 'application/pdf', ext: 'pdf', pages, stats, note: note.join(' · '),
  };
}

function isPdf(u8) {
  const head = String.fromCharCode.apply(null, u8.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** 트레일러 근처에 /Encrypt 가 있는지 (pdf-lib 가 못 여는 손상 파일용 빠른 검사) */
function hasEncryptKey(u8) {
  const tail = u8.subarray(Math.max(0, u8.length - 4096));
  return String.fromCharCode.apply(null, tail).includes('/Encrypt');
}

/* ---------- 똑같은 스트림 합치기 (폰트·이미지가 페이지마다 따로 들어간 경우) ---------- */
function dedupeStreams(L, doc) {
  const { PDFRawStream, PDFDict, PDFArray, PDFRef } = L;
  const ctx = doc.context;
  const seen = new Map();   // key → ref
  const remap = new Map();  // dup tag → canonical ref
  const dups = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const c = obj.contents;
    if (c.length < 256) continue;
    const key = `${c.length}:${fnv(c)}:${obj.dict.toString()}`;
    const first = seen.get(key);
    if (first && equalBytes(ctx.lookup(first).contents, c)) { remap.set(ref.tag, first); dups.push(ref); }
    else if (!first) seen.set(key, ref);
  }
  if (!remap.size) return 0;

  const fix = (o, depth = 0) => {
    if (depth > 64 || !o) return;
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        if (v instanceof PDFRef) { const to = remap.get(v.tag); if (to) o.set(k, to); }
        else fix(v, depth + 1);
      }
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i);
        if (v instanceof PDFRef) { const to = remap.get(v.tag); if (to) o.set(i, to); }
        else fix(v, depth + 1);
      }
    } else if (o.dict instanceof PDFDict) {
      fix(o.dict, depth + 1);
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj);
  dups.forEach((ref) => ctx.delete(ref));
  return dups.length;
}

function fnv(u8) {
  let h = 0x811c9dc5;
  const step = u8.length > 1 << 20 ? 7 : 1; // 큰 스트림은 표본만 (길이·사전·전체 비교로 최종 확인)
  for (let i = 0; i < u8.length; i += step) { h ^= u8[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------- 화면에 안 보이는 부가 데이터 제거 ---------- */
function stripExtras(L, doc) {
  const { PDFName, PDFRawStream, PDFDict } = L;
  const N = (s) => PDFName.of(s);
  const catalog = doc.catalog;
  catalog.delete(N('PieceInfo'));
  // XMP 메타데이터: PDF/A 문서는 규격상 필요하므로 남긴다
  const xmp = catalog.lookup(N('Metadata'));
  if (xmp instanceof PDFRawStream) {
    let text = '';
    try { text = new TextDecoder().decode(L.decodePDFRawStream(xmp).decode()); } catch { text = 'pdfaid'; }
    if (!/pdfaid/i.test(text)) catalog.delete(N('Metadata'));
  }
  for (const page of doc.getPages()) {
    page.node.delete(N('PieceInfo')); // 편집 프로그램 전용 데이터 (일러스트레이터 등)
    page.node.delete(N('Thumb'));     // 미리 만들어 둔 페이지 썸네일
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || !(obj.dict instanceof PDFDict)) continue;
    const sub = obj.dict.lookup(N('Subtype'));
    if (sub && sub.toString() === '/Form') obj.dict.delete(N('PieceInfo'));
  }
}
