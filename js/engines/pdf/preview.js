/* ============================================================
   preview.js — PDF 첫 페이지 미리보기 (화면 쪽, pdf.js)
   ------------------------------------------------------------
   pdf.js 5.4.296 (Apache-2.0)를 PDF 파일을 처음 올렸을 때만
   jsDelivr 에서 불러온다. 문서 해석은 pdf.js 자체 워커가 하고,
   화면에서는 첫 페이지 한 장만 그려 JPEG 그림으로 만든다.
   나누기 화면의 쪽 썸네일(openPages)도 같은 줄(chain)에서 보이는 쪽만 작게 그린다.
   한 번에 하나씩 그려 화면이 버벅이지 않게 한다.
   파일 데이터는 이 브라우저 안에서만 쓰이고 어디로도 전송되지 않는다.
   ============================================================ */

const BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.296';

let libP = null;
function pdfjs() {
  if (!libP) {
    libP = import(`${BASE}/build/pdf.min.mjs`).then((m) => {
      m.GlobalWorkerOptions.workerSrc = `${BASE}/build/pdf.worker.min.mjs`;
      return m;
    });
    libP.catch(() => { libP = null; });
  }
  return libP;
}

let chain = Promise.resolve();
const docOptions = (data) => ({
  data,
  isEvalSupported: false,
  standardFontDataUrl: `${BASE}/standard_fonts/`,
  cMapUrl: `${BASE}/cmaps/`,
  cMapPacked: true,
  wasmUrl: `${BASE}/wasm/`,
  iccUrl: `${BASE}/iccs/`,
});

/**
 * PDF(Blob/File)의 첫 페이지를 그림으로.
 * withThumb 이면 같은 그림에서 목록용 작은 썸네일(긴 변 THUMB px)도 따로 만든다.
 * @returns {Promise<{ url, thumbUrl?, width, height, pages }>} url·thumbUrl 은 쓰고 나서 revoke 해야 한다
 */
const THUMB = 128;
// alive() 가 false 면(그새 목록에서 지운 파일) 차례가 와도 그리지 않고 null
export function renderFirstPage(blob, maxWidth = 900, withThumb = false, alive = () => true) {
  const job = chain.then(async () => {
    if (!alive()) return null;
    const lib = await pdfjs();
    const data = new Uint8Array(await blob.arrayBuffer());
    const pdf = await lib.getDocument(docOptions(data)).promise;
    try {
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, maxWidth / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
      let thumbUrl;
      if (withThumb) {
        const s = Math.min(1, THUMB / Math.max(canvas.width, canvas.height));
        const t = document.createElement('canvas');
        t.width = Math.max(1, Math.round(canvas.width * s));
        t.height = Math.max(1, Math.round(canvas.height * s));
        const tc = t.getContext('2d');
        tc.imageSmoothingQuality = 'high';
        tc.drawImage(canvas, 0, 0, t.width, t.height);
        const tb = await new Promise((res) => t.toBlob(res, 'image/jpeg', 0.85));
        if (tb) thumbUrl = URL.createObjectURL(tb);
      }
      canvas.width = canvas.height = 0;
      return { url: URL.createObjectURL(out), thumbUrl, width: viewport.width, height: viewport.height, pages: pdf.numPages };
    } finally {
      pdf.destroy();
    }
  });
  chain = job.catch(() => {});
  return job;
}

/**
 * 나누기 화면의 쪽 썸네일: 문서를 한 번 열어 두고, 보이는 쪽만 작게(긴 변 size px) 그린다.
 * 그리기는 첫 페이지 미리보기와 같은 줄(chain)에 서서 한 장씩 — 화면이 버벅이지 않게.
 * close() 뒤에 줄에 남은 그리기는 건너뛴다.
 * @returns {Promise<{ pages, thumb(n, size): Promise<Blob|null>, close() }>}
 */
export async function openPages(blob) {
  const lib = await pdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const pdf = await lib.getDocument(docOptions(data)).promise;
  let closed = false;
  return {
    pages: pdf.numPages,
    thumb(n, size) {
      const job = chain.then(async () => {
        if (closed) return null;
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: size / Math.max(base.width, base.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        await page.render({ canvas, viewport }).promise;
        page.cleanup();
        const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
        canvas.width = canvas.height = 0;
        return out;
      });
      chain = job.catch(() => {});
      return job.catch(() => null);
    },
    close() {
      if (closed) return;
      closed = true;
      chain = chain.then(() => pdf.destroy()).catch(() => {});
    },
  };
}
