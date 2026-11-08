/* ============================================================
   split.js — PDF 나누기 엔진 (UI 없음, 워커 안에서만 import)
   splitPdf(file, { method, text, every, base }, ctx) → result
   ------------------------------------------------------------
   method: 'one' 고른 쪽만 PDF 하나로 · 'ranges' 범위마다 따로 · 'every' N쪽마다 · 'each' 한 쪽씩
   pdf-lib copyPages 로 쪽을 그대로 옮겨 담는다 — 그림으로 바꾸지 않아 글자 선택·검색이 그대로.
   암호(보안) PDF 는 손대지 않고 안내. 결과 이름 = base_p1-3.pdf
   result: { kind: 'split', parts: [{ bytes, name, pages, first }], pages, size, lost }
   파일은 워커 안에서만 다뤄지며 어디로도 전송되지 않습니다.
   ============================================================ */

import { openPdf } from './open.js';
import { prepareSource, copyInto, tidy, saveDoc } from './copy.js';
import { splitGroups, fileLabel } from '../../shared/pageRanges.js';
import { t as tx } from '../../i18n/index.js';

const INFO = ['Title', 'Author', 'Subject', 'Keywords', 'Creator'];

export async function splitPdf(file, o, ctx) {
  ctx.progress(tx('pdf.003'), 0.02);
  const src = new Uint8Array(await file.arrayBuffer());
  const { L, doc } = await openPdf(src, ctx, { encrypted: () => tx('split.001') });
  const total = doc.getPageCount();

  // 쪽 번호를 실제 쪽 수로 다시 확인 (화면이 쪽 수를 모른 채 보냈을 수도 있다)
  const groups = splitGroups(o, total)
    .map((g) => [...new Set(g)].filter((p) => p >= 1 && p <= total))
    .filter((g) => g.length);
  if (!groups.length) throw new Error(tx('split.003'));

  ctx.progress(tx('split.004'), 0.08);
  const { lost } = prepareSource(L, doc);
  const info = {};
  for (const k of INFO) { try { const v = doc[`get${k}`](); if (v) info[k] = v; } catch { /* 없음 */ } }
  const lang = doc.catalog.lookup(L.PDFName.of('Lang'));

  const base = o.base || 'document';
  const parts = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    ctx.progress(tx('split.002', { p: i + 1, n: groups.length }), 0.1 + 0.88 * (i / groups.length));
    const out = await L.PDFDocument.create({ updateMetadata: false });
    lost.links += await copyInto(L, out, doc, g.map((p) => p - 1));
    for (const [k, v] of Object.entries(info)) { try { out[`set${k}`](k === 'Keywords' ? [v] : v); } catch { /* 건너뜀 */ } }
    if (lang) out.catalog.set(L.PDFName.of('Lang'), lang);
    await out.flush();
    tidy(L, out);
    const bytes = await saveDoc(out);
    parts.push({ bytes, name: `${base}_p${fileLabel(g)}.pdf`, pages: g.length, first: g[0] });
  }
  const size = parts.reduce((n, p) => n + p.bytes.length, 0);
  return { kind: 'split', parts, pages: total, size, mime: 'application/pdf', ext: 'pdf', lost };
}
