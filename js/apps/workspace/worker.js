/* ============================================================
   worker.js — 작업실 처리 워커 (모듈 워커, 한 번에 한 파일)
   ------------------------------------------------------------
   options.engine 에 따라 UI 없는 엔진을 그때그때 불러와 실행한다.
     'compress' → js/engines/imageCompress.js  (사진 용량 줄이기)
     'resize'   → js/engines/imageResize.js    (사진 크기 조절·목표 용량)
     'pdf'      → js/engines/pdf/compress.js   (PDF 용량 줄이기)
     'doc'      → js/engines/doc/compress.js   (문서 안 사진 줄이기: HWP·HWPX·DOCX·PPTX·XLSX)
   엔진은 처음 쓸 때만 불러오므로, 사진만 다루면 PDF 라이브러리는 받지 않는다.
   파일은 이 워커 안에서만 다뤄지며 어디로도 전송되지 않습니다.
   ============================================================ */

import { serve } from '../../shared/image/workerHost.js';
import { t as tx } from '../../i18n/index.js';

const ENGINES = {
  compress: () => import('../../engines/imageCompress.js').then((m) => m.compressImage),
  resize: () => import('../../engines/imageResize.js').then((m) => m.resizeImage),
  pdf: () => import('../../engines/pdf/compress.js').then((m) => m.compressPdf),
  doc: () => import('../../engines/doc/compress.js').then((m) => m.compressDoc),
};

serve(async (file, options, ctx) => {
  const load = ENGINES[options.engine];
  if (!load) throw new Error(tx('worker.001'));
  const run = await load();
  return run(file, options, ctx);
});
