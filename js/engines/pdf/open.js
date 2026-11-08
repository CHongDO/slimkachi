/* ============================================================
   open.js — PDF 열기 공통부 (워커 전용): 압축·나누기·합치기가 같이 쓴다
   ------------------------------------------------------------
   ① PDF 시그니처 확인  ② pdf-lib 로 열기  ③ 암호(보안) PDF 는 손대지 않고 안내(notice)
   ④ pdf-lib 가 못 여는 손상 파일은 qpdf 로 복구해 다시 연다.
   파일은 워커 안에서만 다뤄지며 어디로도 전송되지 않습니다.
   ============================================================ */

import { loadPdfLib, runQpdf } from './libs.js';
import { t as tx } from '../../i18n/index.js';

/** 오류가 아니라 '처리할 수 없는 파일' 안내 (화면에서 경고색으로 표시). encrypted 는 화면이 기억해 둔다 */
export const notice = (message, extra = {}) => Object.assign(new Error(message), { notice: true }, extra);

/**
 * @param {Uint8Array} src
 * @param {{ progress(label, pct) }} ctx
 * @param {{ encrypted?: () => string }} o  암호 PDF 안내 문구 (기능마다 다름)
 * @returns {Promise<{ L, doc, load }>} load = 같은 옵션으로 다른 바이트 열기 (검증용)
 */
export async function openPdf(src, ctx, { encrypted = () => tx('pdf.001') } = {}) {
  if (!isPdf(src)) throw new Error(tx('pdf.004'));
  ctx.progress(tx('pdf.005'), 0.04);
  const L = await loadPdfLib();
  const load = (bytes) => L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const locked = () => notice(encrypted(), { encrypted: true });

  let doc = null;
  try { doc = await load(src); } catch (e) { console.warn('pdf-lib load', e); }
  if (doc && doc.isEncrypted) throw locked();
  if (!doc) {
    // 구조가 깨진 파일: qpdf 로 먼저 복구해 본다
    if (hasEncryptKey(src)) throw locked();
    ctx.progress(tx('pdf.006'), 0.06);
    try { doc = await load(await runQpdf(src, ['--object-streams=disable'])); }
    catch { throw new Error(tx('pdf.007')); }
    if (doc.isEncrypted) throw locked();
  }
  return { L, doc, load };
}

export function isPdf(u8) {
  const head = String.fromCharCode.apply(null, u8.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** 트레일러 근처에 /Encrypt 가 있는지 (pdf-lib 가 못 여는 손상 파일용 빠른 검사) */
function hasEncryptKey(u8) {
  const tail = u8.subarray(Math.max(0, u8.length - 4096));
  return String.fromCharCode.apply(null, tail).includes('/Encrypt');
}
