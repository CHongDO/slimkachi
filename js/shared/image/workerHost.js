/* ============================================================
   workerHost.js — 워커 공용 메시지 처리 (워커 전용)
   ------------------------------------------------------------
   각 앱의 worker.js 는 serve(processFile) 만 호출하면 됩니다.
     processFile(file, options, ctx) → result
       ctx.progress(label, 0~1)  진행 표시
       ctx.thumb(blob)           목록용 작은 미리보기
   result.bytes(Uint8Array)는 복사 없이 화면으로 넘깁니다(transfer).
   파일은 이 워커 안에서만 다뤄지며 어디로도 전송되지 않습니다.
   ============================================================ */

import { preload } from './codecs.js';

export function serve(processFile) {
  self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === 'preload') { preload(msg.formats || []); return; }
    if (msg.type !== 'process') return;
    const { id, file, options } = msg;
    const ctx = {
      progress: (stage, pct) => self.postMessage({ type: 'progress', id, stage, pct }),
      thumb: (blob) => self.postMessage({ type: 'thumb', id, blob }),
    };
    try {
      const result = await processFile(file, options || {}, ctx);
      ctx.progress('완료', 1);
      const transfer = result.bytes ? [result.bytes.buffer] : [];
      self.postMessage({ type: 'done', id, result }, transfer);
    } catch (err) {
      const notice = !!(err && err.notice); // 처리할 수 없는 파일 안내(암호 PDF 등) — 오류 아님
      // code: 'unsupported' = 브라우저·전용 디코더 모두 못 여는 형식 · 'network' = 디코더를 못 받음
      const code = err && err.unsupported ? 'unsupported' : err && err.network ? 'network' : '';
      if (!notice && !code) console.error(err);
      self.postMessage({ type: 'error', id, notice, code, message: (err && err.message) || String(err) });
    }
  };
}
