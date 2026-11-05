/* ============================================================
   thumbWorker.js — 사진 열어 보기(판별) + 목록 썸네일 워커
   ------------------------------------------------------------
   확장자로 거르지 않고, 올린 파일을 실제로 열어 본다.
     ① 매직 바이트로 형식 짐작 (JPG·PNG·WebP·GIF·BMP·ICO·AVIF·HEIC·TIFF …, 몰라도 계속)
     ② 브라우저 디코딩 → 안 되면 HEIC·TIFF 전용 디코더(그 파일이 들어왔을 때만 내려받음)
     ③ 열리면: 크기 · 투명 영역 유무 · 움직이는 이미지 여부 · 작은 WebP 썸네일
        (+ 브라우저 <img> 가 못 그리는 형식이면 비교 화면용 미리보기 그림)
     못 열면 code 'unsupported' 오류 → 화면이 '지원하지 않는 형식'으로 목록에서 뺀다.
   처리 워커와 따로 돌아 긴 처리 중에도 새 사진이 바로 보인다. (PDF 썸네일은 pdf.js 첫 페이지 그림)
   파일은 이 워커 안에서만 다뤄지며 어디로도 전송되지 않습니다.
   ============================================================ */

import { serve } from '../../shared/image/workerHost.js';
import { detectType, isAnimated } from '../../shared/image/metadata.js';
import { decodeSource, closeSource, makeThumb, detectAlpha, drawToCanvas } from '../../shared/image/pipeline.js';
import { t as tx } from '../../i18n/index.js';

const ALPHA_CHECK_PIXELS = 16_000_000;   // 이보다 크면 줄여서 투명 영역 검사 (반투명 평균이 남아 충분히 잡힘)
const PREVIEW_PNG_PIXELS = 8_000_000;    // 미리보기 그림: 이하면 PNG(그대로), 넘으면 고화질 JPG
const UNKNOWN_MAX_BYTES = 100 * 1000 * 1000;

const unsupported = () => Object.assign(new Error(tx('thumb.001')), { unsupported: true });

serve(async (file, options) => {
  // 문서(한글·오피스): 형식·보안 여부·사진 수만 확인 (그림 미리보기 없음)
  if (options && options.kind === 'doc') return (await import('../../engines/doc/probe.js')).probeDoc(file);
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const type = detectType(head);
  if (type === 'svg' || type === 'psd') throw unsupported();
  // 형식을 모르고 사진 MIME 도 아닌 아주 큰 파일(동영상·압축 파일 등)은 통째로 읽지 않는다
  if (!type && !/^image\//.test(file.type) && file.size > UNKNOWN_MAX_BYTES) throw unsupported();

  const src = new Uint8Array(await file.arrayBuffer());
  const source = await decodeSource(src, type);
  try {
    const width = source.width, height = source.height;
    const hasAlpha = type !== 'jpeg' && alphaOf(source);
    const blob = await makeThumb(source, 128);   // 목록용 작은 썸네일 (긴 변 128px)
    // 전용 디코더로 연 형식(HEIC·TIFF 등)은 화면의 <img> 도 못 그리므로 비교용 그림을 만들어 준다
    let preview = null;
    if (source instanceof ImageData) {
      const c = new OffscreenCanvas(width, height);
      c.getContext('2d').putImageData(source, 0, 0);
      preview = await c.convertToBlob(hasAlpha || width * height <= PREVIEW_PNG_PIXELS
        ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.95 });
    }
    return { blob, preview, width, height, type: type || 'unknown', hasAlpha, animated: isAnimated(type, src) };
  } finally {
    if (!(source instanceof ImageData)) closeSource(source);
  }
});

function alphaOf(source) {
  if (source instanceof ImageData) return detectAlpha(source.data);
  const s = Math.min(1, Math.sqrt(ALPHA_CHECK_PIXELS / (source.width * source.height)));
  const w = Math.max(1, Math.round(source.width * s)), h = Math.max(1, Math.round(source.height * s));
  const c = drawToCanvas(source, w, h);
  return detectAlpha(c.getContext('2d').getImageData(0, 0, w, h).data);
}
