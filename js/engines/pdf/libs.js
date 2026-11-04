/* ============================================================
   libs.js — PDF 라이브러리 로더 (워커 전용, 지연 로딩)
   ------------------------------------------------------------
   - pdf-lib 1.17.1 (MIT)          : PDF 구조 읽기/쓰기, 이미지 객체 교체
   - qpdf 12 (Apache-2.0) WASM     : 무손실 재작성 (객체 스트림, Flate 재압축,
     @neslinesli93/qpdf-wasm (ISC)   안 쓰는 리소스 제거, 손상 파일 복구)
   ※ Ghostscript(AGPL)는 라이선스 때문에 쓰지 않는다.
   PDF 파일을 처음 처리할 때만 내려받는다(사진만 다루면 받지 않음).
   ============================================================ */

const PDFLIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js';
const QPDF_BASE = 'https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist';

let pdfLibP = null;
export function loadPdfLib() {
  if (!pdfLibP) {
    pdfLibP = import(PDFLIB_URL);
    pdfLibP.catch(() => { pdfLibP = null; });
  }
  return pdfLibP;
}

/*
 * qpdf-wasm 의 글루 파일은 CommonJS(module.exports) 형식이라 ES import 가 안 된다.
 * 그래서 CDN 에서 글루 코드를 받아 module/exports 를 넘겨 실행한다(파일 데이터와 무관).
 * .wasm 은 한 번만 받아 두고, 실행마다 새 인스턴스를 만든다(qpdf 는 main() 이 끝나면 상태가 남음).
 * qpdf 의 경고 메시지는 콘솔에만 찍힌다(파일 내용은 찍지 않음).
 */
let qpdfP = null;
function loadQpdf() {
  if (!qpdfP) {
    qpdfP = (async () => {
      const [js, wasm] = await Promise.all([
        fetch(`${QPDF_BASE}/qpdf.js`).then((r) => { if (!r.ok) throw new Error('qpdf.js'); return r.text(); }),
        fetch(`${QPDF_BASE}/qpdf.wasm`).then((r) => { if (!r.ok) throw new Error('qpdf.wasm'); return r.arrayBuffer(); }),
      ]);
      const module = { exports: {} };
      // eslint-disable-next-line no-new-func
      new Function('module', 'exports', js)(module, module.exports);
      // 글루는 locateFile 만 받는다 → 받아 둔 .wasm 을 워커 메모리 안의 blob 주소로 넘긴다
      const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
      return { factory: module.exports.default || module.exports, wasmUrl };
    })();
    qpdfP.catch(() => { qpdfP = null; });
  }
  return qpdfP;
}

/**
 * qpdf 실행: input(Uint8Array) → output(Uint8Array).
 * 종료 코드 0(정상)과 3(경고만 있음)을 성공으로 본다.
 */
export async function runQpdf(input, args) {
  const { factory, wasmUrl } = await loadQpdf();
  const m = await factory({ locateFile: () => wasmUrl });
  m.FS.writeFile('/in.pdf', input);
  let code;
  try {
    code = m.callMain(['/in.pdf', ...args, '/out.pdf']);
  } catch (e) {
    code = typeof e?.status === 'number' ? e.status : 2;
  }
  if (code !== 0 && code !== 3) throw new Error(`qpdf 실패 (종료 코드 ${code})`);
  return m.FS.readFile('/out.pdf');
}
