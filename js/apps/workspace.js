/* ============================================================
   workspace.js — 작업실 (사진·PDF 통합 화면)
   ------------------------------------------------------------
   흐름: 올리기 → 목록에서 선택 → 설정·적용 → 결과 확인 → 내보내기
   - 위: 통합 업로드 (사진 + PDF, 섞어서 가능). 사진은 확장자로 거르지 않고 썸네일 워커가 실제로 열어 본다
     (브라우저가 읽는 형식 전부 + HEIC·TIFF 는 전용 디코더). 못 열면 '지원하지 않는 형식'으로 목록에서 뺀다.
   - 저장 형식: 원본 유지 / JPG / PNG / WebP (+ AVIF 를 브라우저가 열 수 있을 때).
     원본 형식으로 저장할 수 없는 사진(BMP·HEIC·GIF·TIFF·ICO·AVIF)은 원본 유지를 막고 자동 형식(formats.js).
   - 아래 3단: 왼쪽 설정 / 가운데 목록 / 오른쪽 결과 확인
     (모바일: 목록 → 설정 → 결과 순서로 세로 배치)
   - 설정은 파일마다 따로 저장되고 [적용]을 누른 파일 하나만 처리한다.
   - 실제 처리는 UI 없는 엔진(js/engines/)을 워커 하나가 한 번에 한 파일씩 돌린다.
   - 결과는 메모리(Blob)로만 보관하고, 지우거나 덮어쓸 때 object URL 을 해제한다.
   파일은 브라우저 메모리 안에서만 다뤄지고 서버로 전송되지 않습니다.
   ============================================================ */

import { icon } from '../icons.js';
import { loadCss, formatBytes, changeText, renameExt } from '../shared/util.js';
import { WorkerPool } from '../shared/workerPool.js';
import { SAVEABLE, autoFormat, outputFormat, FORMAT_NAME, LOSSY_SOURCES } from '../shared/formats.js';
import { currentLimits, assess, mbText, mpText } from '../shared/limits.js';

const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
const WORKER_URL = new URL('./workspace/worker.js', import.meta.url);
const THUMB_URL = new URL('./workspace/thumbWorker.js', import.meta.url);

/* ---------- 파일 종류 ---------- */
// PDF 가 아니면 모두 '사진 후보' — 실제로 열리는지는 썸네일 워커가 확인한다
const KINDS = {
  image: { label: '사진', icon: 'image' },
  pdf: { mimes: ['application/pdf'], ext: /\.pdf$/i, label: 'PDF', icon: 'pdf' },
  // 문서: 확장자로 고르고, 시그니처(ZIP·복합 파일)는 올릴 때 limits.js 가, 구조·보안은 썸네일 워커가 확인
  doc: { ext: /\.(hwp|hwpx|docx|pptx|xlsx)$/i, label: '문서', icon: 'doc' },
};
// 파일 고르기 창의 기본 필터 (Windows 는 HEIC·TIFF 에 MIME 이 없어 확장자도 적는다). 드래그로는 무엇이든 받는다.
const ACCEPT = 'image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.ico,.avif,.heic,.heif,.tif,.tiff,.hwp,.hwpx,.docx,.pptx,.xlsx';
const SUPPORTED_TEXT = 'JPG·PNG·WebP·BMP·GIF·AVIF·HEIC·TIFF·ICO';
const RESULT_LABEL = { jpg: 'JPG', png: 'PNG', webp: 'WebP', avif: 'AVIF', pdf: 'PDF' };
// 아주 작은 AVIF(1×1) — 이 브라우저가 AVIF 를 그릴 수 있는지 확인용 (결과 비교·미리보기에 필요)
const AVIF_PROBE = 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=';

// 목록 보기 필터 (보기만 바뀌고 파일은 그대로). PDF 는 '문서'와 '전체'에. 주소 #photo · #doc 로도 지정
const FILTERS = [
  { id: 'all', label: '전체', hash: '' },
  { id: 'photo', label: '사진', hash: '#photo' },
  { id: 'doc', label: '문서', hash: '#doc' },
];
const inFilter = (kind, f) => f === 'all' || (f === 'photo' ? kind === 'image' : kind !== 'image');
const filterFromHash = () => (FILTERS.find((f) => f.hash && f.hash === location.hash) || FILTERS[0]).id;

function kindOf(file) {
  if (KINDS.pdf.mimes.includes(file.type) || KINDS.pdf.ext.test(file.name)) return 'pdf';
  if (KINDS.doc.ext.test(file.name)) return 'doc';
  return 'image';
}
const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toLowerCase() : ''; };
/** 원본 형식 이름 (사진은 열어 본 결과, 그 전이나 모르는 형식은 확장자) */
function srcLabel(item) {
  if (item.kind === 'pdf') return 'PDF';
  if (item.kind === 'doc') return extOf(item.file.name).toUpperCase();
  const t = item.info.type;
  if (t === 'heic' && extOf(item.file.name) === 'heif') return 'HEIF';
  if (t && FORMAT_NAME[t]) return FORMAT_NAME[t];
  return extOf(item.file.name).toUpperCase() || '사진';
}
/** 실제로 저장될 형식 (원본 유지인데 원본 형식으로 못 저장하면 자동 형식) */
const effFormat = (item, s = item.settings) => outputFormat(s.format, item.info.type);
const canKeep = (item) => !item.info.type || SAVEABLE.includes(item.info.type);

/* ---------- 설정 정의 ---------- */
const IMAGE_MODES = [
  { id: 'size', label: '용량 우선', hint: '눈에 띄지 않는 선에서 최대한 줄입니다' },
  { id: 'balanced', label: '균형', hint: '용량과 화질의 중간' },
  { id: 'quality', label: '화질 우선', hint: '원본과 거의 구별되지 않는 화질 유지' },
];
const PDF_MODES = [
  { id: 'size', label: '용량 우선', hint: 'PDF 속 사진을 화면·일반 인쇄에 충분한 해상도(150ppi)로 맞추고 최대한 줄입니다' },
  { id: 'balanced', label: '균형', hint: '사진을 200ppi까지 유지하며 용량과 화질의 중간으로 줄입니다' },
  { id: 'quality', label: '화질 우선', hint: '사진을 300ppi까지 유지하고, 확대해도 원본과 거의 같은 화질로 줄입니다' },
];
const DOC_MODES = [
  { id: 'size', label: '용량 우선', hint: '문서 안 사진을 긴 변 2000px까지 줄이고 눈에 띄지 않는 선에서 최대한 압축합니다' },
  { id: 'balanced', label: '균형', hint: '사진을 긴 변 2560px까지 유지하며 용량과 화질의 중간으로 줄입니다' },
  { id: 'quality', label: '화질 우선', hint: '사진 해상도는 그대로 두고 원본과 거의 구별되지 않는 화질로 줄입니다' },
];
const RESIZES = [
  { id: 'none', label: '안 함', hint: '해상도는 그대로 두고 용량만 줄입니다.' },
  { id: 'percent', label: '비율(%)', hint: '가로·세로를 같은 비율로 줄입니다.' },
  { id: 'pixels', label: '픽셀', hint: '비율 유지가 켜져 있으면 입력한 가로·세로 칸 안에 맞춰 줄입니다. 한쪽만 입력해도 됩니다.' },
  { id: 'target', label: '목표 용량', hint: '먼저 화질을 낮춰 보고, 그래도 크면 해상도를 줄여 목표 이하로 맞춥니다. (1KB = 1000바이트로 여유 있게 계산)' },
];
const PERCENTS = [75, 50, 33, 25];
const PRESETS = [
  { px: 1920, label: '1920px' },
  { px: 1280, label: '1280px' },
  { px: 1080, label: '1080px (SNS)' },
  { px: 800, label: '800px' },
];
const TARGET_PRESETS = [
  { kb: 500, label: '500KB' },
  { kb: 1000, label: '1MB' },
  { kb: 2000, label: '2MB' },
];
const FORMATS = [
  { id: 'same', label: '원본 유지' },
  { id: 'jpeg', label: 'JPG' },
  { id: 'png', label: 'PNG (무손실)' },
  { id: 'webp', label: 'WebP' },
  { id: 'avif', label: 'AVIF' },   // 이 브라우저가 AVIF 를 열 수 있을 때만 보인다
];
const UNIT = { KB: 1000, MB: 1000 * 1000 };
const MIN_TARGET = 10 * 1000;

// bg(JPG 투명 배경 채우기 색)의 기본값은 mount 때 theme.css 의 --jpg-fill-default 에서 읽는다
const DEFAULTS = {
  image: { mode: 'size', resize: 'none', percent: '50', width: '1920', height: '1920', keepRatio: true, target: '1', targetUnit: 'MB', format: 'same', bg: '' },
  pdf: { mode: 'size' },
  doc: { mode: 'size' },
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => { const n = Math.round(num(v)); return n > 0 ? n : 0; };
const targetBytes = (s) => (num(s.target) > 0 ? Math.round(num(s.target) * UNIT[s.targetUnit]) : 0);
/** 투명 배경 채우기가 필요한지 (투명 영역이 있는 사진을 JPG 로 저장) */
const needsFill = (item, s = item.settings) => !!item.info.hasAlpha && effFormat(item, s) === 'jpeg';

/** 화면 설정 → 엔진 옵션 (형식은 실제로 저장될 형식으로 풀어서 넘긴다) */
function toOptions(item, s = item.settings) {
  if (item.kind === 'pdf') return { engine: 'pdf', mode: s.mode };
  if (item.kind === 'doc') return { engine: 'doc', mode: s.mode };
  const format = s.format === 'same' && !canKeep(item) ? effFormat(item, s) : s.format;
  const extra = needsFill(item, s) ? { bg: s.bg } : {};
  if (s.resize === 'none') return { engine: 'compress', mode: s.mode, format, maxDim: 0, ...extra };
  const o = { engine: 'resize', method: s.resize, format, ...extra };
  if (s.resize === 'percent') { o.percent = Math.min(100, int(s.percent) || 50); o.mode = s.mode; }
  if (s.resize === 'pixels') { o.width = int(s.width); o.height = int(s.height); o.keepRatio = !!s.keepRatio; o.mode = s.mode; }
  if (s.resize === 'target') o.targetBytes = Math.max(MIN_TARGET, targetBytes(s) || 1000 * 1000);
  return o;
}

/** 설정 확인: { text, block } — block 이면 적용 불가 */
function checkSettings(kind, s) {
  if (kind !== 'image') return null;
  if (s.resize === 'percent' && num(s.percent) > 100) return { text: '원본보다 크게 늘릴 수는 없어 100%로 처리합니다.', block: false };
  if (s.resize === 'percent' && !int(s.percent)) return { text: '비율을 1~100 사이로 입력해 주세요.', block: true };
  if (s.resize === 'pixels' && !int(s.width) && !int(s.height)) return { text: '가로나 세로 중 하나는 입력해 주세요.', block: true };
  if (s.resize === 'target' && !targetBytes(s)) return { text: '목표 용량을 입력해 주세요.', block: true };
  if (s.resize === 'target' && targetBytes(s) < MIN_TARGET) return { text: '목표 용량은 10KB 이상으로 정해 주세요.', block: true };
  return null;
}

const keyOf = (o) => JSON.stringify(o);
/** 진행 게이지 폭: 20칸 세그먼트라 5% 단위로 끊어 한 칸씩 찬다 */
const gauge = (pct) => `${Math.floor(Math.min(Math.max(pct, 0), 1) * 20) * 5}%`;
const seg = (name, list, cols) => `
  <div class="ws-seg" style="--cols:${cols}">
    ${list.map((m) => `
      <label class="ws-seg__opt">
        <input type="radio" name="${name}" value="${m.id}">
        <span>${m.label}</span>
      </label>`).join('')}
  </div>`;
const chip = (attrs, label) => `<button type="button" class="ws-chip" aria-pressed="false" ${attrs}>${label}</button>`;

/* ============================================================ */

export default {
  id: 'workspace',
  title: '작업실',
  icon: icon('logo', 16),

  mount(container) {
    loadCss('css/apps/workspace.css');
    container.innerHTML = template(currentLimits());
    const $ = (sel) => container.querySelector(sel);

    const state = { items: [], nextId: 1, selectedId: null };
    const jobs = new Map(); // 작업 번호 → 항목
    let jobSeq = 0;
    let previewLib = null; // PDF 미리보기(pdf.js)는 PDF를 처음 올릴 때만 불러온다

    // JPG 투명 배경 채우기 기본색 (theme.css 변수 — 색값을 여기 적지 않는다)
    const fillDefault = (getComputedStyle(document.documentElement).getPropertyValue('--jpg-fill-default').trim() || '').toLowerCase();
    DEFAULTS.image.bg = /^#[0-9a-f]{6}$/.test(fillDefault) ? fillDefault : DEFAULTS.image.bg;
    // AVIF 저장은 이 브라우저가 AVIF 를 열 수 있을 때만 (결과 비교·화질 검증에 필요). 인코더는 WASM.
    let avifOk = false;
    (async () => {
      try {
        if (typeof WebAssembly !== 'object') return;
        const bin = Uint8Array.from(atob(AVIF_PROBE), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bin], { type: 'image/avif' }));
        avifOk = bmp.width > 0;
        bmp.close();
      } catch { avifOk = false; }
      renderSettings();
    })();

    const pool = new WorkerPool(WORKER_URL, 1, onWorkerMessage, onWorkerCrash); // 한 번에 한 파일
    const thumbs = new WorkerPool(THUMB_URL, 1, onThumbMessage, () => {});

    const drop = $('.ws-drop');
    const input = $('#ws-file');
    const list = $('.ws-list');
    const dropMsg = $('.ws-drop__msg');
    const selected = () => state.items.find((it) => it.id === state.selectedId) || null;

    /* ===================== 올리기 ===================== */
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    drop.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });

    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const onDragEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; drop.classList.add('is-over'); };
    const onDragOver = (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    const onDragLeave = () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('is-over'); };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      drop.classList.remove('is-over');
      addFiles(e.dataTransfer.files);
    };
    // 페이지 어디에 놓아도 받는다 (브라우저가 파일을 열어 버리는 것 방지)
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);

    // 열어 보지 못해 목록에서 뺀 파일 (올릴 때마다 새로 모은다)
    let rejected = { unsupported: [], broken: [], network: [] };
    // 올리기는 차례대로 (위험 계수를 재는 동안 다음 올리기가 끼어들어 목록 한도를 넘지 않게)
    let addChain = Promise.resolve();
    function addFiles(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      addChain = addChain.then(() => addChecked(files)).catch((err) => console.error(err));
    }

    /**
     * 위험 계수로 거른 뒤 목록에 넣는다 (처리 전, 이미지 전체를 디코딩하지 않고 헤더만 읽음).
     *  ① 파일 하나가 단일 한도(사진·PDF)를 넘으면 제외
     *  ② 목록에 있는 파일 + 새 파일의 개수·총용량이 목록 한도를 넘으면, 올린 순서대로 넘치는 파일부터 제외
     * 하나라도 제외되면 안내 팝업.
     */
    async function addChecked(files) {
      const lim = currentLimits();
      const risks = await Promise.all(files.map((f) => assess(f, kindOf(f)).catch(() => null)));
      let count = state.items.length;
      let total = state.items.reduce((n, it) => n + it.file.size, 0);
      const ok = [], excluded = [];
      files.forEach((file, i) => {
        const kind = kindOf(file);
        const r = risks[i];
        if (kind === 'doc' && r && r.sigError) {
          excluded.push({ file, why: 'docsig', text: r.sigError });
        } else if (kind === 'doc' && r && r.risk > lim.doc) {
          excluded.push({ file, why: 'doc', text: `문서 용량이 너무 큽니다 (최대 ${mbText(lim.maxDocFile)})` });
        } else if (kind === 'pdf' && r && r.risk > lim.pdf) {
          excluded.push({ file, why: 'pdf', text: `PDF 용량이 너무 큽니다 (최대 ${mbText(lim.maxPdfFile)})` });
        } else if (kind === 'image' && r && r.risk > lim.photo) {
          excluded.push(r.byHeader
            ? { file, why: 'photo', text: `해상도(${r.width}×${r.height}, ${mpText(r.width * r.height)})가 너무 높아 이 기기에서 처리 중 멈출 수 있습니다 (최대 약 ${mpText(lim.maxPixels)})` }
            : { file, why: 'photo', text: `사진 파일이 너무 커서 이 기기에서 처리 중 멈출 수 있습니다 (최대 약 ${mbText(lim.maxPhotoFile)})` });
        } else if (count + 1 > lim.count) {
          excluded.push({ file, why: 'list', text: `한 번에 올릴 수 있는 개수(${lim.count}개)를 넘었습니다` });
        } else if (total + file.size > lim.total) {
          excluded.push({ file, why: 'list', text: `목록 전체 용량(${mbText(lim.total)})을 넘었습니다` });
        } else {
          count++;
          total += file.size;
          ok.push(file);
        }
      });
      addItems(ok);
      if (excluded.length) showExcluded(excluded, ok.length);
    }

    function addItems(files) {
      const added = [];
      rejected = { unsupported: [], broken: [], network: [] };
      dropMsg.textContent = '';
      for (const file of files) {
        const kind = kindOf(file);
        const item = {
          id: state.nextId++, file, kind,
          settings: { ...DEFAULTS[kind] },
          applied: null, job: null,
          status: 'idle', pct: 0, stage: '',
          result: null, blob: null, outUrl: null, origUrl: null, thumbUrl: null, previewUrl: null,
          previews: {}, info: {}, exported: false, notice: false,
          probing: kind !== 'pdf', // 사진·문서는 실제로 열리는지 확인이 끝나야 설정·적용 가능
        };
        item.el = createRow(item);
        list.appendChild(item.el);
        state.items.push(item);
        added.push(item);
        if (kind === 'image') thumbs.add({ id: item.id, file, options: {} });
        else if (kind === 'doc') thumbs.add({ id: item.id, file, options: { kind: 'doc' } });   // 형식·보안·사진 수만
        else loadPdfThumb(item);
        renderRow(item);
      }
      if (added.length && !selected()) select(added[0].id);
      // 지금 필터에서 안 보이는 종류를 올렸으면 전체 보기로 (올린 파일이 사라진 것처럼 보이지 않게)
      if (added.some((it) => !inFilter(it.kind, filter))) setFilter('all');
      renderAll();
    }

    /* ---------- 올리지 못한 파일 안내 팝업 (모달) ---------- */
    const modal = $('.ws-modal');
    let modalReturn = null;
    const FIXES = {
      photo: '사진 크기를 줄여서 다시 올려 주세요. (휴대폰·사진 앱의 크기 조절이나 다른 기기를 이용해 보세요)',
      pdf: 'PDF를 여러 개로 나누어 다시 올려 주세요.',
      doc: '문서를 여러 개로 나누어 다시 올려 주세요.',
      docsig: '한글·오피스에서 문서를 연 뒤 HWP·HWPX·DOCX·PPTX·XLSX 형식으로 다시 저장해 올려 주세요.',
      list: '먼저 올린 파일을 내보낸 뒤 목록을 비우고 다시 올려 주세요.',
    };
    function showExcluded(excluded, addedCount) {
      const ul = modal.querySelector('.ws-modal__list');
      ul.textContent = '';
      for (const x of excluded) {
        const li = document.createElement('li');
        const name = document.createElement('strong');
        name.textContent = x.file.name;
        const why = document.createElement('span');
        why.textContent = x.text;
        li.append(name, why);
        ul.append(li);
      }
      modal.querySelector('.ws-modal__lead').textContent = addedCount
        ? `${excluded.length}개 파일은 목록에 넣지 않았고, 나머지 ${addedCount}개는 정상적으로 추가했습니다.`
        : `${excluded.length}개 파일을 목록에 넣지 않았습니다.`;
      const whys = [...new Set(excluded.map((x) => x.why))];
      modal.querySelector('.ws-modal__fix').textContent = whys.map((w) => FIXES[w]).join(' ');
      modalReturn = document.activeElement;
      if (typeof modal.showModal === 'function') modal.showModal(); else modal.setAttribute('open', '');
      ul.tabIndex = ul.scrollHeight > ul.clientHeight ? 0 : -1;   // 길면 키보드로 스크롤할 수 있게
      modal.querySelector('[data-act="modal-ok"]').focus();
    }
    function closeModal() {
      if (modal.open) { if (typeof modal.close === 'function') modal.close(); else modal.removeAttribute('open'); }
      // 원래 자리로 포커스를 돌려준다 (숨은 파일 입력·body 였다면 업로드 칸으로)
      const back = modalReturn && modalReturn !== document.body && document.contains(modalReturn) && modalReturn.offsetParent !== null ? modalReturn : drop;
      back.focus();
      modalReturn = null;
    }
    modal.querySelector('[data-act="modal-ok"]').addEventListener('click', closeModal);
    modal.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(); });   // Esc
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
      if (e.key === 'Enter') { e.preventDefault(); closeModal(); return; }
      if (e.key !== 'Tab') return;
      // 포커스가 팝업 밖으로 나가지 않게 (목록 → 확인 → 목록 …)
      const f = [...modal.querySelectorAll('button, [tabindex="0"]')].filter((el) => !el.disabled);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    });

    /** 열지 못한 파일을 목록에서 빼고 이유를 업로드 칸 아래에 알린다 */
    function reject(item, code) {
      (rejected[code] || rejected.broken).push(item.file.name);
      removeItem(item.id);
      const names = (arr) => arr.slice(0, 3).join(', ') + (arr.length > 3 ? ` 외 ${arr.length - 3}개` : '');
      const lines = [];
      if (rejected.unsupported.length) lines.push(`이 형식은 아직 지원하지 않습니다 (지원: ${SUPPORTED_TEXT}…): ${names(rejected.unsupported)}`);
      if (rejected.broken.length) lines.push(`파일을 열 수 없어 제외했습니다 (손상되었을 수 있어요): ${names(rejected.broken)}`);
      if (rejected.network.length) lines.push(`변환 도구를 내려받지 못해 제외했습니다. 인터넷 연결을 확인한 뒤 다시 올려 주세요: ${names(rejected.network)}`);
      dropMsg.textContent = lines.join(' / ');
    }

    /* ===================== 미리보기 ===================== */
    const origUrlOf = (item) => item.origUrl || (item.origUrl = URL.createObjectURL(item.file));

    async function pdfPreview(blob, withThumb = false) {
      if (!previewLib) previewLib = import('../engines/pdf/preview.js');
      return (await previewLib).renderFirstPage(blob, undefined, withThumb);
    }
    /** 'before' | 'after' 그림 { url, width, height }
        (사진은 파일 그대로 — HEIC·TIFF 처럼 <img> 가 못 그리는 형식은 워커가 만든 미리보기, PDF 는 첫 페이지 그림) */
    function getPreview(item, which) {
      if (item.kind === 'doc') {
        // 문서 자체 미리보기는 없다. 결과가 있으면 가장 큰 사진 하나의 전후
        const c = item.result && item.result.compare;
        if (!c) return Promise.resolve(null);
        if (!item.cmpUrls) item.cmpUrls = { before: URL.createObjectURL(c.before), after: URL.createObjectURL(c.after) };
        return Promise.resolve({ url: item.cmpUrls[which], width: which === 'after' ? c.width : c.origWidth });
      }
      if (item.kind === 'image') {
        const before = item.previewUrl || origUrlOf(item);
        const url = which === 'after' ? (item.outUrl || before) : before;
        const r = item.result;
        const width = which === 'after' && r && r.width ? r.width : item.info.width;
        return Promise.resolve({ url, width });
      }
      if (!item.previews[which]) {
        const src = which === 'after' ? item.blob : item.file;
        // 원본 첫 페이지를 그릴 때 목록용 작은 썸네일(긴 변 128px)도 같이 만든다
        item.previews[which] = pdfPreview(src, which === 'before').catch((err) => {
          if (!err || err.name !== 'PasswordException') console.warn(err); // 암호 PDF 는 미리보기 없음 (안내는 적용 시)
          return null;
        });
      }
      return item.previews[which];
    }
    function dropPreview(item, which) {
      const pv = item.previews[which];
      if (!pv) return;
      delete item.previews[which];
      pv.then((r) => { if (r && r.url) URL.revokeObjectURL(r.url); });
    }
    async function loadPdfThumb(item) {
      const r = await getPreview(item, 'before');
      if (!state.items.includes(item)) { if (r && r.thumbUrl) URL.revokeObjectURL(r.thumbUrl); return; }
      if (r) {
        // 목록에는 작은 썸네일만 (큰 첫 페이지 그림은 결과 비교 화면 전용)
        item.thumbUrl = r.thumbUrl || null;
        item.el.querySelector('.ws-item__thumb img').src = r.thumbUrl || r.url;
        item.info.pages = r.pages;
        renderRow(item);
        if (item.id === state.selectedId) renderView();
      } else {
        item.info.previewFailed = true;
        if (item.id === state.selectedId) renderView();
      }
    }
    /** 사진 열어 보기 결과: 크기·원본 형식·투명 영역·움직임 + 썸네일. 못 열면 목록에서 뺀다.
        문서는 형식·사진 수. 보안 문서(암호·배포용·DRM·전자 서명)는 목록에 남기고 '처리 불가'로 안내. */
    function onThumbMessage(msg) {
      if (msg.type !== 'done' && msg.type !== 'error') return;
      const item = state.items.find((it) => it.id === msg.id);
      if (!item) return;
      if (item.kind === 'doc') {
        item.probing = false;
        if (msg.type === 'error' && msg.notice) {
          item.info.secure = msg.message;
          item.status = 'error';
          item.notice = true;
          item.stage = msg.message;
        } else if (msg.type === 'error') { reject(item, msg.code || 'broken'); return; }
        else Object.assign(item.info, { images: msg.result.images, compressible: msg.result.compressible, docType: msg.result.docType });
        renderRow(item);
        if (item.id === state.selectedId) { renderSettings(); renderView(); }
        return;
      }
      if (msg.type === 'error') { reject(item, msg.code || 'broken'); return; }
      const r = msg.result;
      item.probing = false;
      item.thumbUrl = URL.createObjectURL(r.blob);
      if (r.preview) item.previewUrl = URL.createObjectURL(r.preview);
      Object.assign(item.info, { width: r.width, height: r.height, type: r.type, hasAlpha: r.hasAlpha, animated: r.animated });
      // 원본 형식으로 저장할 수 없으면 '원본 유지' 대신 자동 형식을 처음부터 골라 둔다
      if (item.settings.format === 'same' && !canKeep(item)) item.settings.format = autoFormat(r.type);
      item.el.querySelector('.ws-item__thumb img').src = item.thumbUrl;
      renderRow(item);
      if (item.id === state.selectedId) { renderSettings(); renderView(); preloadFor(item); }
    }

    /* ===================== 처리 (한 번에 한 파일) ===================== */
    function clearResult(item) {
      if (item.outUrl) URL.revokeObjectURL(item.outUrl);
      item.outUrl = null;
      item.blob = null;
      item.result = null;
      if (item.cmpUrls) { URL.revokeObjectURL(item.cmpUrls.before); URL.revokeObjectURL(item.cmpUrls.after); item.cmpUrls = null; }
      item.exported = false;
      item.notice = false;
      dropPreview(item, 'after');
    }

    function stopJob(item) {
      if (item.job == null) return;
      pool.abort(item.job);
      jobs.delete(item.job);
      item.job = null;
    }

    function start(item, options) {
      stopJob(item);
      clearResult(item);
      item.applied = options;
      item.job = ++jobSeq;
      jobs.set(item.job, item);
      item.status = 'queued';
      item.pct = 0;
      item.stage = '처리 대기';
      pool.add({ id: item.job, file: item.file, options });
    }

    function applyTo(item) {
      const chk = checkSettings(item.kind, item.settings);
      if ((chk && chk.block) || item.probing) return false;
      start(item, toOptions(item));
      return true;
    }

    function revert(item) {
      stopJob(item);
      clearResult(item);
      item.applied = null;
      item.status = 'idle';
      item.pct = 0;
      item.stage = '';
    }

    function onWorkerMessage(msg) {
      const item = jobs.get(msg.id);
      if (!item || item.job !== msg.id) return; // 지워졌거나 다시 적용된 작업
      if (msg.type === 'thumb') return; // 썸네일은 썸네일 워커가 만든다
      if (msg.type === 'progress') {
        item.status = 'working';
        item.pct = msg.pct;
        item.stage = msg.stage;
        renderRow(item);
        if (item.id === state.selectedId) renderProgress(item);
        return;
      }
      jobs.delete(msg.id);
      item.job = null;
      if (msg.type === 'done') {
        const r = msg.result;
        if (r.kind === 'original') {
          item.blob = item.file;
        } else {
          item.blob = new Blob([r.bytes], { type: r.mime });
          item.outUrl = URL.createObjectURL(item.blob);
          delete r.bytes;
        }
        item.result = r;
        item.status = 'done';
        item.pct = 1;
      } else {
        item.status = 'error';
        item.notice = !!msg.notice;
        item.stage = msg.message || '처리 중 오류가 발생했습니다';
      }
      afterChange(item);
    }

    function onWorkerCrash(jobId) {
      const item = jobs.get(jobId);
      jobs.delete(jobId);
      if (!item || item.job !== jobId) return;
      item.job = null;
      item.status = 'error';
      item.stage = item.kind === 'image'
        ? '처리 중 문제가 생겼습니다(메모리 부족일 수 있어요). 아주 큰 사진이면 크기 조정을 함께 써 보세요.'
        : item.kind === 'doc' ? '처리 중 문제가 생겼습니다(메모리 부족일 수 있어요). 다른 탭을 닫고 다시 시도해 보세요.'
        : '처리 중 문제가 생겼습니다(메모리 부족일 수 있어요). 다른 탭을 닫고 다시 시도해 보세요.';
      afterChange(item);
    }

    function afterChange(item) {
      renderRow(item);
      if (item.id === state.selectedId) { renderSettings(); renderView(); }
      renderSummary();
    }

    /* ===================== 목록 ===================== */
    function createRow(item) {
      const li = document.createElement('li');
      li.className = 'ws-item';
      li.dataset.id = item.id;
      li.dataset.kind = item.kind;
      li.innerHTML = `
        <button type="button" class="ws-item__main" data-act="select">
          <span class="ws-item__thumb"><img alt="" decoding="async"><span class="ws-item__ph">${icon(KINDS[item.kind].icon, 22)}</span></span>
          <span class="ws-item__body">
            <span class="ws-item__name"></span>
            <span class="ws-item__meta"><span class="ws-tag"></span><span class="ws-item__orig"></span></span>
            <span class="ws-item__state"><span class="ws-status"></span><span class="ws-item__out"></span></span>
            <span class="ws-progress" aria-hidden="true"><span></span></span>
          </span>
        </button>
        <div class="ws-item__actions">
          <a class="btn btn--icon" data-act="download" title="이 파일 받기">${icon('download', 18)}<span class="sr-only">이 파일 받기</span></a>
          <button type="button" class="btn btn--icon" data-act="remove" title="목록에서 삭제">${icon('close', 18)}<span class="sr-only">목록에서 삭제</span></button>
        </div>`;
      li.querySelector('.ws-item__name').textContent = item.file.name;
      li.querySelector('.ws-item__name').title = item.file.name;
      li.querySelector('.ws-tag').textContent = srcLabel(item);
      li.querySelector('.ws-item__orig').textContent = formatBytes(item.file.size);
      return li;
    }

    function statusOf(item) {
      if (item.probing) return { text: '형식 확인 중', tone: 'busy' };
      switch (item.status) {
        case 'queued': return { text: '처리 대기', tone: 'busy' };
        case 'working': return { text: `처리 중 ${Math.round(item.pct * 100)}%`, tone: 'busy' };
        case 'done': return { text: '완료', tone: 'good' };
        case 'error': return item.notice ? { text: '처리 불가', tone: 'warn' } : { text: '오류', tone: 'danger' };
        default: return { text: '대기', tone: 'muted' };
      }
    }
    const isDirty = (item) => !!item.applied && keyOf(toOptions(item)) !== keyOf(item.applied);
    const outName = (item) => renameExt(item.file.name, item.result.ext, '_min');

    function renderRow(item) {
      const el = item.el;
      const sel = item.id === state.selectedId;
      el.classList.toggle('is-selected', sel);
      el.dataset.status = item.status;
      const main = el.querySelector('.ws-item__main');
      main.setAttribute('aria-current', sel ? 'true' : 'false');
      const st = statusOf(item);
      const stEl = el.querySelector('.ws-status');
      stEl.textContent = st.text;
      stEl.className = `ws-status ws-status--${st.tone}`;
      const out = el.querySelector('.ws-item__out');
      out.textContent = '';
      const r = item.result;
      if (item.status === 'done' && r) {
        if (r.kind === 'original') {
          out.append('원본 유지');
        } else {
          const to = document.createElement('strong');
          to.textContent = `→ ${formatBytes(r.size)}`;
          const badge = document.createElement('span');
          badge.className = `ws-badge ws-badge--${r.warn ? 'warn' : r.size < item.file.size ? 'good' : 'muted'}`;
          badge.textContent = changeText(item.file.size, r.size);
          out.append(to, badge);
          if (r.converted) {           // 형식 변화 (예: PNG → JPG)
            const fmt = document.createElement('span');
            fmt.className = 'ws-item__fmt';
            fmt.textContent = `${srcLabel(item)} → ${RESULT_LABEL[r.ext] || r.ext.toUpperCase()}`;
            out.append(fmt);
          }
        }
      } else if (item.status === 'error') {
        out.textContent = item.stage;
      }
      if (isDirty(item)) {
        const d = document.createElement('span');
        d.className = 'ws-item__dirty';
        d.textContent = '설정 바뀜';
        out.append(d);
      }
      el.querySelector('.ws-progress').hidden = !(item.status === 'working' || item.status === 'queued');
      el.querySelector('.ws-tag').textContent = srcLabel(item);
      el.querySelector('.ws-progress span').style.width = gauge(item.pct);
      const label = item.info.width ? `${item.info.width}×${item.info.height}` : item.info.pages ? `${item.info.pages}쪽`
        : item.kind === 'doc' && item.info.images !== undefined ? `사진 ${item.info.images}장` : '';
      el.querySelector('.ws-item__orig').textContent = [formatBytes(item.file.size), label].filter(Boolean).join(' · ');
      const dl = el.querySelector('[data-act="download"]');
      if (item.status === 'done' && r) {
        dl.href = item.outUrl || origUrlOf(item);
        dl.download = outName(item);
        dl.removeAttribute('aria-disabled');
        dl.tabIndex = 0;
      } else {
        dl.removeAttribute('href');
        dl.removeAttribute('download');
        dl.setAttribute('aria-disabled', 'true');
        dl.tabIndex = -1;
      }
      const name = item.file.name;
      main.setAttribute('aria-label', `${name}, ${srcLabel(item)}, ${st.text}`);
    }

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = Number(btn.closest('.ws-item').dataset.id);
      const act = btn.dataset.act;
      if (act === 'select') select(id, { user: true });
      if (act === 'remove') removeItem(id);
      if (act === 'download') {
        if (!btn.getAttribute('href')) { e.preventDefault(); return; }
        markExported(id);
      }
    });
    // 위·아래 화살표로 목록 이동
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const row = e.target.closest('.ws-item');
      if (!row || !e.target.matches('.ws-item__main')) return;
      const step = (el) => (e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling);
      let next = step(row);
      while (next && next.hidden) next = step(next);   // 필터로 숨긴 줄은 건너뛴다
      if (!next) return;
      e.preventDefault();
      select(Number(next.dataset.id));
      next.querySelector('.ws-item__main').focus();
    });

    /* ===================== 목록 필터 ===================== */
    const filterEl = $('.ws-filter');
    let filter = filterFromHash();
    function setFilter(f, { fromHash = false } = {}) {
      filter = FILTERS.some((x) => x.id === f) ? f : 'all';
      if (!fromHash) {
        const hash = FILTERS.find((x) => x.id === filter).hash;
        history.replaceState(null, '', location.pathname + location.search + hash);
      }
      renderFilter();
      // 고른 파일이 이 보기에서 숨겨졌으면 보이는 첫 파일로 옮긴다
      const cur = selected();
      if (cur && !inFilter(cur.kind, filter)) {
        const first = state.items.find((it) => inFilter(it.kind, filter));
        select(first ? first.id : null);
      }
    }
    function renderFilter() {
      const counts = { all: state.items.length, photo: 0, doc: 0 };
      for (const it of state.items) {
        if (it.kind === 'image') counts.photo++; else counts.doc++;
        it.el.hidden = !inFilter(it.kind, filter);
      }
      filterEl.querySelectorAll('[data-filter]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
        b.querySelector('.ws-filter__n').textContent = counts[b.dataset.filter];
      });
      filterEl.hidden = state.items.length === 0;
      const none = state.items.length > 0 && counts[filter] === 0;
      const msg = $('.ws-list__filtered');
      msg.hidden = !none;
      msg.textContent = none ? `${FILTERS.find((x) => x.id === filter).label} 파일이 없습니다. [전체]를 누르면 올린 파일이 모두 보입니다.` : '';
    }
    filterEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (b) setFilter(b.dataset.filter);
    });
    const onHash = () => setFilter(filterFromHash(), { fromHash: true });
    window.addEventListener('hashchange', onHash);

    function markExported(id) {
      const item = state.items.find((it) => it.id === id);
      if (item) item.exported = true;
      renderSummary();
    }

    function removeItem(id) {
      const idx = state.items.findIndex((it) => it.id === id);
      if (idx < 0) return;
      const [item] = state.items.splice(idx, 1);
      stopJob(item);
      thumbs.cancel(item.id);
      item.el.remove();
      revokeAll(item);
      if (state.selectedId === id) {
        const next = state.items[idx] || state.items[idx - 1];
        select(next ? next.id : null);
      }
      renderAll();
    }

    function revokeAll(item) {
      clearResult(item);
      dropPreview(item, 'before');
      if (item.origUrl) URL.revokeObjectURL(item.origUrl);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      item.origUrl = item.thumbUrl = item.previewUrl = null;
    }

    $('[data-act="clear"]').addEventListener('click', () => {
      if (!state.items.length) return;
      if (unsavedCount() && !confirm('내보내지 않은 결과가 있습니다. 모두 지울까요?')) return;
      [...state.items].forEach((it) => removeItem(it.id));
    });

    /* ===================== 선택 ===================== */
    function select(id, { user = false } = {}) {
      state.selectedId = id;
      state.items.forEach(renderRow);
      renderSettings();
      renderView();
      const item = selected();
      if (item) preloadFor(item);
      if (user && isNarrow()) $('.ws-settings').scrollIntoView({ behavior: smooth(), block: 'start' });
    }
    /** 쓸 코덱을 미리 받아 둔다 (적용 후 첫 대기 시간 단축). 형식 확인 전에는 기다린다. */
    function preloadFor(item) {
      if (item.kind === 'image' && !item.probing) pool.preload([effFormat(item)]);
    }
    const isNarrow = () => window.matchMedia('(max-width: 720px)').matches;
    const smooth = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

    /* ===================== 설정 (왼쪽) ===================== */
    const setEl = $('.ws-settings');
    const imgSet = $('.ws-set[data-kind="image"]');
    const pdfSet = $('.ws-set[data-kind="pdf"]');
    const docSet = $('.ws-set[data-kind="doc"]');
    const applyBtn = $('[data-act="apply"]');
    const revertBtn = $('[data-act="revert"]');
    const applyAllBtn = $('[data-act="apply-all"]');
    const setMsg = $('.ws-set__msg');

    function fillImage(s) {
      const q = (sel) => imgSet.querySelector(sel);
      imgSet.querySelectorAll('input[name="ws-mode-image"]').forEach((r) => { r.checked = r.value === s.mode; });
      imgSet.querySelectorAll('input[name="ws-resize"]').forEach((r) => { r.checked = r.value === s.resize; });
      q('#ws-percent').value = s.percent;
      q('#ws-width').value = s.width;
      q('#ws-height').value = s.height;
      q('#ws-keep').checked = s.keepRatio;
      q('#ws-target').value = s.target;
      q('#ws-target-unit').value = s.targetUnit;
      // 저장 형식: 원본 형식으로 못 저장하는 사진은 '원본 유지'를 막고, AVIF 는 이 브라우저가 열 수 있을 때만
      const item = selected();
      const sel = q('#ws-format');
      const can = canKeep(item);
      const keepOpt = sel.querySelector('option[value="same"]');
      keepOpt.disabled = !can;
      keepOpt.textContent = !item.info.type ? '원본 유지'
        : can ? `원본 유지 (${srcLabel(item)})` : `원본 유지 (${srcLabel(item)}는 저장 불가)`;
      const avifOpt = sel.querySelector('option[value="avif"]');
      avifOpt.hidden = avifOpt.disabled = !avifOk;
      if (s.format === 'same' && !can) s.format = autoFormat(item.info.type);
      if (s.format === 'avif' && !avifOk) s.format = can ? 'same' : autoFormat(item.info.type);
      sel.value = s.format;
      q('#ws-bg').value = s.bg || DEFAULTS.image.bg;
      syncImage(s);
    }
    function readImage() {
      const q = (sel) => imgSet.querySelector(sel);
      const checked = (name) => imgSet.querySelector(`input[name="${name}"]:checked`).value;
      return {
        mode: checked('ws-mode-image'),
        resize: checked('ws-resize'),
        percent: q('#ws-percent').value,
        width: q('#ws-width').value,
        height: q('#ws-height').value,
        keepRatio: q('#ws-keep').checked,
        target: q('#ws-target').value,
        targetUnit: q('#ws-target-unit').value,
        format: q('#ws-format').value,
        bg: q('#ws-bg').value || DEFAULTS.image.bg,
      };
    }

    /** 저장 형식 안내: 원본 형식으로 못 저장하는 이유 · 첫 장면만 · 화질/용량 · AVIF */
    function formatHints(item, s) {
      const t = item.info.type;
      const name = srcLabel(item);
      const eff = effFormat(item, s);
      const lines = [];
      if (t && !SAVEABLE.includes(t)) {
        if (t === 'heic') lines.push(`${name}는 많은 기기·사이트에서 열리지 않아 원본 형식으로 저장할 수 없습니다. 기본은 어디서나 열리는 JPG입니다.`);
        else if (t === 'avif') lines.push('AVIF는 원본 형식 그대로 저장하지 않습니다. 기본은 어디서나 열리는 JPG입니다.');
        else if (t === 'bmp' || t === 'tiff') lines.push(`${name}는 압축이 없거나 약한 형식이라 원본 형식으로 저장하지 않습니다. 기본은 화질이 그대로인 무손실 PNG입니다.`);
        else lines.push(`${name}는 원본 형식으로 저장할 수 없어 기본으로 무손실 PNG로 바꿉니다.`);
      }
      if (item.info.animated && (t === 'gif' || eff !== t)) {
        lines.push(t === 'gif' ? '움직이는 GIF는 첫 장면만 저장됩니다.' : '움직이는 이미지는 형식을 바꾸면 첫 장면만 저장됩니다.');
      }
      if (LOSSY_SOURCES.includes(t) && eff === 'png') {
        lines.push('화질은 그대로이고 용량은 커질 수 있습니다(이미 줄어든 화질은 복원되지 않습니다).');
      } else if (t && SAVEABLE.includes(t) && eff !== t) {
        lines.push('형식을 바꾸면 결과가 원본보다 커도 바꾼 형식으로 저장합니다.');
      }
      if (eff === 'avif') lines.push('AVIF는 저장에 시간이 더 걸리고, 오래된 기기에서는 열리지 않을 수 있습니다.');
      return lines.join(' ');
    }
    function syncImage(s) {
      imgSet.querySelectorAll('.ws-rpanel').forEach((p) => { p.hidden = p.dataset.panel !== s.resize; });
      const item = selected();
      const isTarget = s.resize === 'target';
      const isPng = item && effFormat(item, s) === 'png';
      const modeField = imgSet.querySelector('.ws-mode');
      modeField.disabled = isTarget || isPng;
      modeField.querySelector('.ws-hint').textContent = isTarget
        ? '목표 용량 방식은 목표에 맞추는 것이 우선이라 용량 모드를 쓰지 않습니다.'
        : isPng ? 'PNG는 화질 손실 없는 무손실 최적화만 해서 용량 모드를 쓰지 않습니다.'
        : IMAGE_MODES.find((m) => m.id === s.mode).hint;
      if (item) {
        imgSet.querySelector('.ws-format-hint').textContent = formatHints(item, s);
        imgSet.querySelector('.ws-bg').hidden = !needsFill(item, s);
      }
      imgSet.querySelectorAll('[data-percent]').forEach((b) => b.setAttribute('aria-pressed', String(int(s.percent) === Number(b.dataset.percent))));
      imgSet.querySelectorAll('[data-preset]').forEach((b) => {
        const px = Number(b.dataset.preset);
        b.setAttribute('aria-pressed', String(s.keepRatio && int(s.width) === px && int(s.height) === px));
      });
      imgSet.querySelectorAll('[data-kb]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.kb) * 1000 === targetBytes(s))));
      const chk = checkSettings('image', s);
      const hint = imgSet.querySelector('.ws-resize-hint');
      hint.textContent = chk ? chk.text : RESIZES.find((r) => r.id === s.resize).hint;
      hint.classList.toggle('ws-hint--warn', !!chk);
    }
    function fillPdf(s) {
      pdfSet.querySelectorAll('input[name="ws-mode-pdf"]').forEach((r) => { r.checked = r.value === s.mode; });
      pdfSet.querySelector('.ws-hint').textContent = PDF_MODES.find((m) => m.id === s.mode).hint;
    }
    const readPdf = () => ({ mode: pdfSet.querySelector('input[name="ws-mode-pdf"]:checked').value });
    function fillDoc(s) {
      const item = selected();
      docSet.querySelectorAll('input[name="ws-mode-doc"]').forEach((r) => { r.checked = r.value === s.mode; });
      docSet.querySelector('.ws-hint').textContent = DOC_MODES.find((m) => m.id === s.mode).hint;
      const cnt = docSet.querySelector('.ws-doc__count');
      if (!item || item.probing) cnt.textContent = '문서 안 사진을 세는 중…';
      else if (item.info.secure) cnt.textContent = item.info.secure;
      else {
        const n = item.info.images || 0, m = item.info.compressible || 0;
        cnt.textContent = n === 0 ? '문서 안 사진 0장 — 줄일 사진이 없는 문서입니다'
          : `문서 안 사진 ${n}장` + (m < n ? ` (그중 줄일 수 있는 JPG·PNG ${m}장)` : '');
      }
      cnt.classList.toggle('ws-hint--warn', !!(item && item.info.secure));
    }
    const readDoc = () => ({ mode: docSet.querySelector('input[name="ws-mode-doc"]:checked').value });

    function onSettingsInput() {
      const item = selected();
      if (!item) return;
      item.settings = item.kind === 'image' ? readImage() : item.kind === 'doc' ? readDoc() : readPdf();
      if (item.kind === 'image') syncImage(item.settings);
      else if (item.kind === 'doc') fillDoc(item.settings);
      else fillPdf(item.settings);
      renderActions(item);
      renderRow(item);
    }
    imgSet.addEventListener('input', onSettingsInput);
    imgSet.addEventListener('change', onSettingsInput);
    pdfSet.addEventListener('change', onSettingsInput);
    docSet.addEventListener('change', onSettingsInput);
    imgSet.addEventListener('click', (e) => {
      const b = e.target.closest('.ws-chip');
      if (!b) return;
      const q = (sel) => imgSet.querySelector(sel);
      if (b.dataset.percent) q('#ws-percent').value = b.dataset.percent;
      if (b.dataset.preset) { q('#ws-width').value = b.dataset.preset; q('#ws-height').value = b.dataset.preset; q('#ws-keep').checked = true; }
      if (b.dataset.kb) {
        const kb = Number(b.dataset.kb);
        if (kb % 1000 === 0) { q('#ws-target').value = String(kb / 1000); q('#ws-target-unit').value = 'MB'; }
        else { q('#ws-target').value = String(kb); q('#ws-target-unit').value = 'KB'; }
      }
      onSettingsInput();
    });
    // 100%를 넘게 적으면 입력을 마칠 때 100으로 되돌린다 (업스케일 금지)
    imgSet.querySelector('#ws-percent').addEventListener('change', (e) => {
      if (num(e.target.value) > 100) { e.target.value = '100'; onSettingsInput(); }
    });

    function renderSettings() {
      const item = selected();
      setEl.classList.toggle('is-empty', !item);
      imgSet.hidden = !item || item.kind !== 'image';
      pdfSet.hidden = !item || item.kind !== 'pdf';
      docSet.hidden = !item || item.kind !== 'doc';
      $('.ws-set__file').textContent = item ? item.file.name : '';
      $('.ws-set__kind').textContent = item ? KINDS[item.kind].label : '';
      if (!item) return;
      if (item.kind === 'image') fillImage(item.settings);
      else if (item.kind === 'doc') fillDoc(item.settings);
      else fillPdf(item.settings);
      renderActions(item);
    }

    function renderActions(item) {
      const chk = checkSettings(item.kind, item.settings);
      const dirty = isDirty(item);
      const busy = item.status === 'queued' || item.status === 'working';
      let label = '적용';
      let disabled = !!(chk && chk.block);
      if (item.probing) { label = '형식 확인 중…'; disabled = true; }
      else if (item.info.secure) { label = '처리할 수 없는 문서'; disabled = true; }
      else if (item.applied && (dirty || item.status === 'error')) label = '다시 적용';
      else if (busy) { label = '처리 중…'; disabled = true; }
      else if (item.status === 'done') { label = '적용됨'; disabled = true; }
      applyBtn.querySelector('span').textContent = label;
      applyBtn.disabled = disabled;
      revertBtn.disabled = !item.applied;
      setMsg.textContent = dirty
        ? (busy ? '설정이 바뀌었어요. 다시 적용하면 처리 중인 작업을 멈추고 새로 시작합니다.' : '설정이 바뀌었어요. [다시 적용]을 누르면 결과를 덮어씁니다.')
        : '';
      const same = state.items.filter((it) => it.kind === item.kind && !it.info.secure);   // 처리 못 하는 보안 문서는 빼고 셈
      applyAllBtn.hidden = same.length < 2;
      applyAllBtn.querySelector('span').textContent = `같은 종류 전체에 이 설정 적용 (${KINDS[item.kind].label} ${same.length}개)`;
      applyAllBtn.disabled = !!(chk && chk.block);
    }

    applyBtn.addEventListener('click', () => {
      const item = selected();
      if (!item || !applyTo(item)) return;
      afterChange(item);
      if (isNarrow()) $('.ws-view').scrollIntoView({ behavior: smooth(), block: 'start' });
    });
    revertBtn.addEventListener('click', () => {
      const item = selected();
      if (!item) return;
      revert(item);
      afterChange(item);
    });
    applyAllBtn.addEventListener('click', () => {
      const cur = selected();
      if (!cur) return;
      let n = 0;
      for (const it of state.items) {
        if (it.kind !== cur.kind || it.probing || it.info.secure) continue;   // 보안 문서는 건너뜀
        it.settings = { ...cur.settings };
        // 원본 유지를 못 쓰는 사진(BMP·HEIC 등)은 그 파일의 자동 형식으로
        if (it.kind === 'image' && it.settings.format === 'same' && !canKeep(it)) it.settings.format = autoFormat(it.info.type);
        const opts = toOptions(it);
        const same = it.applied && keyOf(it.applied) === keyOf(opts) && it.status !== 'error';
        if (!same) { start(it, opts); n++; }
        renderRow(it);
      }
      renderSettings();
      renderView();
      renderSummary();
      setMsg.textContent = n ? `${n}개 파일을 차례로 처리합니다.` : '모두 이미 이 설정으로 처리되어 있습니다.';
    });

    /* ===================== 결과 확인 (오른쪽) ===================== */
    const view = $('.ws-view');
    const cmp = $('.ws-cmp');
    const stage = $('.ws-cmp__stage');
    const viewport = $('.ws-cmp__viewport');
    const beforeImg = $('.ws-cmp__before');
    const afterImg = $('.ws-cmp__after');
    const afterWrap = $('.ws-cmp__after-wrap');
    const divider = $('.ws-cmp__divider');
    const range = $('#ws-range');
    const zoomBtn = $('[data-act="zoom"]');
    const viewDl = $('[data-act="view-download"]');
    const statusBox = $('.ws-view__status');
    let zoomed = false;
    let zoomWidth = 0;

    function setSplit(pct) {
      pct = Math.max(0, Math.min(100, pct));
      afterWrap.style.clipPath = `inset(0 0 0 ${pct}%)`;
      divider.style.left = `${pct}%`;
      range.value = String(pct);
    }
    range.addEventListener('input', () => setSplit(Number(range.value)));

    let dragging = false;
    const pointerSplit = (e) => {
      const rect = stage.getBoundingClientRect();
      setSplit(((e.clientX - rect.left) / rect.width) * 100);
    };
    stage.addEventListener('pointerdown', (e) => {
      if (cmp.classList.contains('is-pending')) return;
      if (zoomed && e.pointerType !== 'mouse') return; // 확대 모드에선 터치로 스크롤
      dragging = true;
      stage.setPointerCapture(e.pointerId);
      pointerSplit(e);
    });
    stage.addEventListener('pointermove', (e) => { if (dragging) pointerSplit(e); });
    stage.addEventListener('pointerup', () => { dragging = false; });
    stage.addEventListener('pointercancel', () => { dragging = false; });

    zoomBtn.addEventListener('click', () => {
      zoomed = !zoomed;
      cmp.classList.toggle('is-zoomed', zoomed);
      zoomBtn.setAttribute('aria-pressed', String(zoomed));
      applyZoom();
    });
    function applyZoom() {
      stage.style.width = zoomed && zoomWidth ? `${zoomWidth}px` : '';
      if (zoomed) {
        requestAnimationFrame(() => {
          viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
          viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
        });
      }
    }
    viewDl.addEventListener('click', (e) => {
      if (!viewDl.getAttribute('href')) { e.preventDefault(); return; }
      markExported(state.selectedId);
    });

    function renderProgress(item) {
      const busy = item.status === 'queued' || item.status === 'working';
      const bar = statusBox.querySelector('.ws-progress');
      bar.hidden = !busy;
      bar.firstElementChild.style.width = gauge(item.pct);
      const text = statusBox.querySelector('.ws-view__msg');
      if (item.status === 'queued') text.textContent = '앞의 파일을 처리한 뒤 시작합니다. (한 번에 한 파일씩 처리)';
      else if (item.status === 'working') text.textContent = `${item.stage} · ${Math.round(item.pct * 100)}%`;
    }

    let viewSeq = 0;
    async function renderView() {
      const item = selected();
      view.classList.toggle('is-empty', !item);
      $('.ws-view__body').hidden = !item;
      $('.ws-view__file').textContent = item ? item.file.name : '';
      if (!item) return;
      const seq = ++viewSeq;
      const r = item.result;
      const ready = item.status === 'done' && r;
      const changed = ready && r.kind !== 'original';

      // 상태 안내
      statusBox.dataset.tone = item.status === 'error' ? (item.notice ? 'warn' : 'danger') : ready ? 'good' : 'muted';
      const msg = statusBox.querySelector('.ws-view__msg');
      if (item.status === 'idle') msg.textContent = item.kind === 'doc'
        ? '왼쪽에서 설정한 뒤 [적용]을 눌러주세요. 문서 안 사진만 줄이고 글자·표·서식은 그대로 둡니다.'
        : '왼쪽에서 설정한 뒤 [적용]을 눌러주세요. 지금은 원본 미리보기입니다.';
      else if (item.status === 'error') msg.textContent = item.stage;
      else if (ready) msg.textContent = r.kind === 'original' ? r.note || '원본을 그대로 유지했습니다.'
        : item.kind === 'doc' ? '처리 완료 — 결과 문서를 한글·오피스에서 열어 확인해 주세요. 원본은 따로 보관하세요.'
        : '처리 완료 — 슬라이더를 움직여 원본과 비교해 보세요.';
      renderProgress(item);

      renderStats(item);

      // 다운로드
      if (ready) {
        viewDl.href = item.outUrl || origUrlOf(item);
        viewDl.download = outName(item);
        viewDl.removeAttribute('aria-disabled');
        viewDl.hidden = false;
      } else {
        viewDl.removeAttribute('href');
        viewDl.hidden = true;
      }

      // 그림
      cmp.classList.toggle('is-pending', !changed);
      $('.ws-cmp__caption').textContent = item.kind === 'pdf' ? '첫 페이지'
        : item.kind === 'doc' && r && r.compare ? `문서 안 가장 큰 사진(${r.compare.name}) 전후 · ${formatBytes(r.compare.beforeSize)} → ${formatBytes(r.compare.afterSize)}` : '';
      setSplit(50);
      cmp.classList.add('is-loading');
      const before = await getPreview(item, 'before');
      const after = changed ? await getPreview(item, 'after') : before;
      if (seq !== viewSeq) return; // 그새 다른 파일을 골랐다
      cmp.classList.remove('is-loading');
      cmp.classList.toggle('is-noimg', !before);
      if (before) beforeImg.src = before.url; else beforeImg.removeAttribute('src');
      if (after) afterImg.src = after.url; else afterImg.removeAttribute('src');
      $('.ws-cmp__noimg').textContent = item.kind === 'pdf'
        ? (item.info.previewFailed ? '이 PDF는 미리보기를 만들 수 없습니다.' : '첫 페이지 그리는 중…')
        : item.kind === 'doc'
          ? (ready ? '줄인 사진이 없어 비교할 그림이 없습니다.' : '문서는 미리보기가 없습니다. 적용하면 문서 안 가장 큰 사진 하나의 전후를 여기서 비교해 보여 드립니다.')
          : '미리보기를 만들 수 없습니다.';
      zoomWidth = (after && after.width) || (before && before.width) || 0;
      applyZoom();
    }

    function renderStats(item) {
      const r = item.result;
      const ready = item.status === 'done' && r;
      const tbody = $('.ws-stats tbody');
      tbody.textContent = '';
      const row = (label, a, b) => {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.scope = 'row';
        th.textContent = label;
        const ta = document.createElement('td');
        ta.textContent = a;
        const tb = document.createElement('td');
        tb.textContent = ready ? b : '—';
        tr.append(th, ta, tb);
        tbody.append(tr);
      };
      const ow = (r && r.origWidth) || item.info.width;
      const oh = (r && r.origHeight) || item.info.height;
      if (item.kind === 'image') {
        row('해상도', ow ? `${ow}×${oh}` : '—', r && r.width ? `${r.width}×${r.height}` : ow ? `${ow}×${oh}` : '—');
      } else if (item.kind === 'doc') {
        const n = item.info.images;
        row('사진', n !== undefined ? `${n}장` : '—', r && r.images ? `${r.images.compressed}장 줄임` : '—');
      } else {
        const pages = (r && r.pages) || item.info.pages;
        row('쪽수', pages ? `${pages}쪽` : '—', pages ? `${pages}쪽` : '—');
      }
      row('형식', srcLabel(item), r ? RESULT_LABEL[r.ext] || r.ext.toUpperCase() : '');
      row('용량', formatBytes(item.file.size), r ? formatBytes(r.size) : '');

      const pct = $('.ws-view__pct');
      pct.textContent = ready ? (r.kind === 'original' ? '원본 유지' : changeText(item.file.size, r.size)) : '';
      pct.className = `ws-badge ws-view__pct ws-badge--${ready && r.warn ? 'warn' : ready && r.size < item.file.size ? 'good' : 'muted'}`;
      $('.ws-view__pctline').hidden = !ready;
      $('.ws-view__pctlabel').textContent = ready && r.size > item.file.size ? '용량 변화' : '감소율';

      const bits = [];
      if (ready) {
        if (r.targetBytes) bits.push(r.size <= r.targetBytes ? `목표 ${targetLabel(r.targetBytes)} 이하 ✓` : `목표 ${targetLabel(r.targetBytes)} 초과`);
        if (r.kind === 'lossy' && item.kind === 'image' && r.ssim) bits.push(`원본과 유사도 ${(r.ssim * 100).toFixed(1)}%`);
        if (r.note && r.kind !== 'original') bits.push(r.note);
        if (r.firstFrame) bits.push(item.info.type === 'gif' ? '움직이는 GIF는 첫 장면만 저장했습니다' : '움직이는 이미지라 첫 장면만 저장했습니다');
        if (r.filled) {
          bits.push(r.filled.toLowerCase() === DEFAULTS.image.bg
            ? 'JPG는 투명 배경을 지원하지 않아 흰색으로 채웠습니다'
            : `JPG는 투명 배경을 지원하지 않아 고른 배경색(${r.filled})으로 채웠습니다`);
        }
        if (r.grew) bits.push('형식 변환으로 용량이 늘었습니다');
        if (r.warn) bits.push(r.warn);
        if (item.kind === 'doc') bits.push('결과 문서를 한글·오피스에서 열어 확인해 주세요', '원본은 따로 보관하세요');
      }
      const note = $('.ws-view__note');
      note.textContent = bits.join(' · ');
      note.hidden = !bits.length;
    }

    /* ===================== 요약 · 내보내기 ===================== */
    const doneItems = () => state.items.filter((it) => it.status === 'done' && it.result);
    const unsaved = (it) => it.status === 'done' && it.result && it.result.kind !== 'original' && !it.exported;
    const unsavedCount = () => state.items.filter(unsaved).length;

    function renderSummary() {
      renderFilter();
      const total = state.items.length;
      const done = doneItems();
      $('.ws-list__empty').hidden = total > 0;
      drop.classList.toggle('is-compact', total > 0);
      $('.ws-list__count').textContent = total ? `${total}개 · 완료 ${done.length}개` : '';
      const exp = $('[data-act="export"]');
      exp.disabled = done.length === 0;
      exp.querySelector('span').textContent = done.length ? `전체 내보내기 (${done.length})` : '전체 내보내기';
      $('[data-act="clear"]').hidden = total === 0;
      const sum = $('.ws-list__sum');
      if (done.length) {
        const orig = done.reduce((n, it) => n + it.file.size, 0);
        const out = done.reduce((n, it) => n + it.result.size, 0);
        const left = unsavedCount();
        sum.textContent = `완료한 파일 ${formatBytes(orig)} → ${formatBytes(out)} (${changeText(orig, out)})` + (left ? ` · 내보내지 않은 결과 ${left}개` : '');
        sum.hidden = false;
      } else {
        sum.hidden = true;
      }
    }

    function renderAll() {
      state.items.forEach(renderRow);
      renderSettings();
      renderView();
      renderSummary();
    }

    $('[data-act="export"]').addEventListener('click', exportZip);
    async function exportZip() {
      const btn = $('[data-act="export"]');
      const done = doneItems();
      if (!done.length) return;
      btn.disabled = true;
      const label = btn.querySelector('span');
      label.textContent = 'ZIP 만드는 중…';
      try {
        const { zipSync } = await import(FFLATE_URL);
        const files = {};
        const used = new Set();
        for (const it of done) {
          let name = outName(it);
          if (used.has(name.toLowerCase())) {
            const dot = name.lastIndexOf('.');
            let n = 2;
            while (used.has(`${name.slice(0, dot)} (${n})${name.slice(dot)}`.toLowerCase())) n++;
            name = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
          }
          used.add(name.toLowerCase());
          // 이미 압축된 파일이라 ZIP 압축은 생략(level 0) — 빠르고 크기 차이 없음
          files[name] = [new Uint8Array(await it.blob.arrayBuffer()), { level: 0 }];
        }
        const zip = zipSync(files);
        const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `file-tool_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        done.forEach((it) => { it.exported = true; });
      } catch (err) {
        console.error(err);
        alert('ZIP 파일을 만들지 못했습니다. 네트워크 연결을 확인하거나 개별 다운로드를 이용해 주세요.');
      } finally {
        renderSummary();
      }
    }

    // 내보내지 않은 결과가 있으면 닫기·새로고침 전에 브라우저가 확인을 묻는다
    const onBeforeUnload = (e) => {
      if (!unsavedCount()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    renderAll();

    /* ===================== 정리 ===================== */
    return () => {
      pool.destroy();
      thumbs.destroy();
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      state.items.forEach(revokeAll);
      state.items = [];
    };
  },
};

function targetLabel(bytes) {
  return bytes >= 1000 * 1000 ? `${+(bytes / 1e6).toFixed(2)}MB` : `${+(bytes / 1000).toFixed(1)}KB`;
}

/* ============================================================ */
function template(lim) {
  return `
  <section class="ws">
    <header class="ws-head">
      <h2 class="ws-title">SlimKachi 작업실</h2>
      <ol class="ws-steps" aria-label="사용 순서">
        <li>올리기</li><li>파일 선택</li><li>설정 · 적용</li><li>결과 확인</li><li>내보내기</li>
      </ol>
    </header>

    <div class="ws-drop" tabindex="0" role="button" aria-label="사진·PDF·문서 파일 선택 또는 끌어다 놓기">
      <div class="ws-drop__inner">
        <span class="ws-drop__icon">${icon('upload', 30)}</span>
        <strong>사진·PDF·문서를 끌어다 놓거나 눌러서 선택</strong>
        <span class="muted ws-drop__limit">이 기기 기준 한 번에 최대 ${lim.count}개·${mbText(lim.total)} · 사진 약 ${mpText(lim.maxPixels)} · PDF·문서 ${mbText(lim.maxPdfFile)}까지 · 파일은 서버로 전송되지 않습니다</span>
      </div>
      <input id="ws-file" type="file" accept="${ACCEPT}" multiple hidden>
    </div>
    <!-- 업로드 칸(누르면 파일 선택) 밖에 둔다 — 안에 두면 펼칠 때 파일 창이 열림 -->
    <details class="ws-formats">
      <summary>지원 형식 보기 <span aria-hidden="true">▾</span></summary>
      <dl class="ws-formats__list">
        <div><dt>사진</dt><dd>JPG · PNG · WebP · HEIC(아이폰) · BMP · GIF · AVIF · TIFF <span class="muted">— HEIC·BMP처럼 그대로 저장할 수 없는 형식은 JPG·PNG로 바꿔 줍니다</span></dd></div>
        <div><dt>문서</dt><dd>HWP · HWPX · DOCX · PPTX · XLSX <span class="muted">— 문서 안 사진만 줄이고 글자·표·서식은 그대로</span></dd></div>
        <div><dt>PDF</dt><dd>PDF <span class="muted">— 글자 선택·검색은 그대로 유지</span></dd></div>
      </dl>
    </details>
    <p class="ws-drop__msg" role="status" aria-live="polite"></p>

    <!-- 올리지 못한 파일 안내 (모달). Esc·Enter 로 닫힘, 포커스는 안에 머문다 -->
    <dialog class="card ws-modal" role="dialog" aria-modal="true" aria-labelledby="ws-modal-title" aria-describedby="ws-modal-lead">
      <h2 class="ws-modal__title" id="ws-modal-title">${icon('info', 18)}<span>일부 파일을 올리지 못했어요</span></h2>
      <p class="ws-modal__lead" id="ws-modal-lead"></p>
      <ul class="ws-modal__list" aria-label="올리지 못한 파일"></ul>
      <p class="ws-modal__fix"></p>
      <div class="ws-modal__actions">
        <button type="button" class="btn btn--primary" data-act="modal-ok">${icon('check', 16)}<span>확인</span></button>
      </div>
    </dialog>

    <div class="ws-grid">
      <!-- 왼쪽: 설정 -->
      <section class="ws-panel ws-settings" aria-labelledby="ws-set-title">
        <div class="ws-panel__head">
          <h3 id="ws-set-title">${icon('settings', 18)}<span>설정</span></h3>
          <span class="ws-tag ws-set__kind"></span>
        </div>
        <p class="ws-set__file"></p>
        <p class="ws-empty ws-set__empty">목록에서 파일을 고르면 그 파일에 맞는 설정이 여기에 나옵니다.</p>

        <div class="ws-set" data-kind="image" hidden>
          <fieldset class="ws-field ws-mode">
            <legend>용량 모드</legend>
            ${seg('ws-mode-image', IMAGE_MODES, 3)}
            <p class="ws-hint"></p>
          </fieldset>

          <fieldset class="ws-field">
            <legend>크기 조정</legend>
            ${seg('ws-resize', RESIZES, 2)}
            <div class="ws-rpanel" data-panel="percent" role="group" aria-label="비율">
              <div class="ws-row">
                ${PERCENTS.map((v) => chip(`data-percent="${v}"`, `${v}%`)).join('')}
              </div>
              <div class="ws-row">
                <span class="ws-label">원본의</span>
                <input id="ws-percent" class="input ws-num" type="number" min="1" max="100" step="1" inputmode="numeric" aria-label="비율 직접 입력 (%)">
                <span class="ws-unit">%</span>
              </div>
            </div>
            <div class="ws-rpanel" data-panel="pixels" role="group" aria-label="픽셀" hidden>
              <div class="ws-row">
                <input id="ws-width" class="input ws-num" type="number" min="1" step="1" inputmode="numeric" aria-label="가로 (px)" placeholder="가로">
                <span class="ws-unit" aria-hidden="true">×</span>
                <input id="ws-height" class="input ws-num" type="number" min="1" step="1" inputmode="numeric" aria-label="세로 (px)" placeholder="세로">
                <span class="ws-unit">px</span>
              </div>
              <label class="ws-check"><input id="ws-keep" type="checkbox"> 비율 유지</label>
              <span class="ws-label">자주 쓰는 크기 (긴 변)</span>
              <div class="ws-row">
                ${PRESETS.map((p) => chip(`data-preset="${p.px}"`, p.label)).join('')}
              </div>
            </div>
            <div class="ws-rpanel" data-panel="target" role="group" aria-label="목표 용량" hidden>
              <div class="ws-row">
                ${TARGET_PRESETS.map((t) => chip(`data-kb="${t.kb}"`, `${t.label} 이하`)).join('')}
              </div>
              <div class="ws-row">
                <input id="ws-target" class="input ws-num" type="number" min="0" step="any" inputmode="decimal" aria-label="목표 용량 직접 입력">
                <select id="ws-target-unit" class="input" aria-label="단위">
                  <option value="KB">KB</option>
                  <option value="MB">MB</option>
                </select>
                <span class="ws-unit">이하</span>
              </div>
            </div>
            <p class="ws-hint ws-resize-hint"></p>
          </fieldset>

          <div class="ws-field field">
            <label for="ws-format">저장 형식</label>
            <select id="ws-format" class="input" aria-describedby="ws-format-hint">
              ${FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}
            </select>
            <p class="ws-hint ws-format-hint" id="ws-format-hint"></p>
          </div>

          <div class="ws-field ws-bg" hidden>
            <label for="ws-bg">투명 배경 채우기 색</label>
            <div class="ws-row">
              <input id="ws-bg" class="input ws-color" type="color">
              <span class="ws-hint">JPG는 투명 배경을 지원하지 않아 투명한 부분을 이 색으로 채웁니다.</span>
            </div>
          </div>
        </div>

        <div class="ws-set" data-kind="doc" hidden>
          <fieldset class="ws-field">
            <legend>용량 모드</legend>
            ${seg('ws-mode-doc', DOC_MODES, 3)}
            <p class="ws-hint"></p>
          </fieldset>
          <p class="ws-hint ws-doc__count" role="status"></p>
          <p class="ws-note">${icon('info', 16)}<span>문서 안에 든 사진만 꺼내 같은 형식으로 다시 압축합니다. 글자·표·서식·구조는 그대로이고 형식도 바꾸지 않습니다. 결과 문서를 한글·오피스에서 열어 확인하고, 원본은 따로 보관하세요.</span></p>
        </div>

        <div class="ws-set" data-kind="pdf" hidden>
          <fieldset class="ws-field">
            <legend>압축 모드</legend>
            ${seg('ws-mode-pdf', PDF_MODES, 3)}
            <p class="ws-hint"></p>
          </fieldset>
          <p class="ws-note">${icon('info', 16)}<span>스캔본·사진이 많은 PDF는 크게 줄고, 글자 위주 PDF는 원래 작아서 감소폭이 작을 수 있습니다. 글자·도형은 그대로라 압축 후에도 글자 선택·검색이 됩니다.</span></p>
        </div>

        <div class="ws-actions">
          <p class="ws-set__msg" role="status" aria-live="polite"></p>
          <button type="button" class="btn btn--primary" data-act="apply">${icon('check', 16)}<span>적용</span></button>
          <button type="button" class="btn" data-act="revert">${icon('refresh', 16)}<span>원본으로 되돌리기</span></button>
          <button type="button" class="ws-link" data-act="apply-all" hidden><span></span></button>
        </div>
      </section>

      <!-- 가운데: 목록 -->
      <section class="ws-panel ws-listpanel" aria-labelledby="ws-list-title">
        <div class="ws-panel__head">
          <h3 id="ws-list-title">${icon('image', 18)}<span>파일 목록</span></h3>
          <span class="ws-list__count muted"></span>
          <span class="ws-spacer"></span>
          <button type="button" class="btn btn--icon" data-act="clear" title="모두 지우기" hidden>${icon('trash', 18)}<span class="sr-only">모두 지우기</span></button>
        </div>
        <div class="ws-filter" role="group" aria-label="목록 보기 (파일은 지워지지 않습니다)">
          ${FILTERS.map((f) => `<button type="button" class="ws-chip" data-filter="${f.id}" aria-pressed="${f.id === 'all'}">${f.label} <span class="ws-filter__n">0</span></button>`).join('')}
        </div>
        <p class="ws-empty ws-list__empty">아직 올린 파일이 없습니다. 위에서 사진·PDF·문서를 올려 주세요.</p>
        <p class="ws-empty ws-list__filtered" hidden></p>
        <ul class="ws-list" aria-label="올린 파일"></ul>
        <div class="ws-export">
          <p class="ws-list__sum muted" hidden></p>
          <button type="button" class="btn btn--primary" data-act="export" disabled>${icon('archive', 16)}<span>전체 내보내기</span></button>
          <p class="muted ws-export__hint">처리 완료된 파일만 ZIP으로 받습니다 (파일명_min.확장자)</p>
        </div>
      </section>

      <!-- 오른쪽: 결과 확인 -->
      <section class="ws-panel ws-view" aria-labelledby="ws-view-title">
        <div class="ws-panel__head">
          <h3 id="ws-view-title">${icon('compare', 18)}<span>결과 확인</span></h3>
          <span class="ws-spacer"></span>
          <button type="button" class="btn btn--icon" data-act="zoom" aria-pressed="false" title="실제 크기로 보기">${icon('zoom', 18)}<span class="sr-only">실제 크기로 보기</span></button>
          <a class="btn btn--icon" data-act="view-download" title="이 파일 받기" hidden>${icon('download', 18)}<span class="sr-only">이 파일 받기</span></a>
        </div>
        <p class="ws-empty ws-view__empty">파일을 고르면 원본과 결과를 여기서 비교할 수 있습니다.</p>
        <div class="ws-view__body" hidden>
          <p class="ws-view__file"></p>
          <div class="ws-cmp">
            <div class="ws-cmp__viewport">
              <div class="ws-cmp__stage">
                <img class="ws-cmp__before" alt="원본" draggable="false" decoding="async">
                <div class="ws-cmp__after-wrap"><img class="ws-cmp__after" alt="결과" draggable="false" decoding="async"></div>
                <div class="ws-cmp__divider" aria-hidden="true"></div>
                <span class="ws-cmp__label ws-cmp__label--left">원본</span>
                <span class="ws-cmp__label ws-cmp__label--right">결과</span>
              </div>
              <p class="ws-cmp__noimg muted"></p>
            </div>
            <input id="ws-range" class="ws-cmp__range" type="range" min="0" max="100" step="0.1" value="50" aria-label="비교 위치 (왼쪽 원본, 오른쪽 결과)">
            <p class="ws-cmp__caption muted"></p>
          </div>
          <div class="ws-view__status" data-tone="muted">
            <p class="ws-view__msg"></p>
            <span class="ws-progress" hidden><span></span></span>
          </div>
          <p class="ws-view__pctline"><span class="ws-view__pctlabel">감소율</span> <span class="ws-badge ws-view__pct"></span></p>
          <table class="ws-stats">
            <thead><tr><th scope="col"><span class="sr-only">항목</span></th><th scope="col">원본</th><th scope="col">결과</th></tr></thead>
            <tbody></tbody>
          </table>
          <p class="ws-view__note muted" hidden></p>
        </div>
      </section>
    </div>
  </section>`;
}
