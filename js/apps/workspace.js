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
   - PDF 는 설정 위 탭 [압축] [나누기]. 탭마다 상태가 따로라 나누어도 압축 결과는 그대로 남는다.
     나눈 파일·합친 파일은 목록에 새 항목(item.made)으로 들어가 그대로 내보내거나 이어서 압축할 수 있다.
   - 합치기: 목록 체크박스로 PDF·사진을 2개 이상 고르고 [합치기] → 왼쪽이 합치기 화면(순서·여백·이름)으로 바뀐다.
   파일은 브라우저 메모리 안에서만 다뤄지고 서버로 전송되지 않습니다.
   ============================================================ */

import { icon } from '../icons.js';
import { loadCss, formatBytes, changeText, renameExt } from '../shared/util.js';
import { WorkerPool } from '../shared/workerPool.js';
import { SAVEABLE, autoFormat, outputFormat, FORMAT_NAME, LOSSY_SOURCES } from '../shared/formats.js';
import { currentLimits, assess, mbText, mpText, mergeEstimate } from '../shared/limits.js';
import { parseRanges, formatRanges, splitGroups, fileLabel, groupColor } from '../shared/pageRanges.js';
import { PageGrid } from './workspace/pageGrid.js';
import { sortable } from './workspace/orderList.js';
import { t as tx } from '../i18n/index.js';

const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
const WORKER_URL = new URL('./workspace/worker.js', import.meta.url);
const THUMB_URL = new URL('./workspace/thumbWorker.js', import.meta.url);

/* ---------- 파일 종류 ---------- */
// PDF 가 아니면 모두 '사진 후보' — 실제로 열리는지는 썸네일 워커가 확인한다
const KINDS = {
  image: { label: tx('ws.001'), icon: 'image' },
  pdf: { mimes: ['application/pdf'], ext: /\.pdf$/i, label: 'PDF', icon: 'pdf' },
  // 문서: 확장자로 고르고, 시그니처(ZIP·복합 파일)는 올릴 때 limits.js 가, 구조·보안은 썸네일 워커가 확인
  doc: { ext: /\.(hwp|hwpx|docx|pptx|xlsx)$/i, label: tx('ws.002'), icon: 'doc' },
};
// 파일 고르기 창의 기본 필터 (Windows 는 HEIC·TIFF 에 MIME 이 없어 확장자도 적는다). 드래그로는 무엇이든 받는다.
const ACCEPT = 'image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.ico,.avif,.heic,.heif,.tif,.tiff,.hwp,.hwpx,.docx,.pptx,.xlsx';
const SUPPORTED_TEXT = 'JPG·PNG·WebP·BMP·GIF·AVIF·HEIC·TIFF·ICO';
const RESULT_LABEL = { jpg: 'JPG', png: 'PNG', webp: 'WebP', avif: 'AVIF', pdf: 'PDF' };
// 아주 작은 AVIF(1×1) — 이 브라우저가 AVIF 를 그릴 수 있는지 확인용 (결과 비교·미리보기에 필요)
const AVIF_PROBE = 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=';

// 목록 보기 필터 (보기만 바뀌고 파일은 그대로). PDF 는 '문서'와 '전체'에. 주소 #photo · #doc 로도 지정
const FILTERS = [
  { id: 'all', label: tx('ws.003'), hash: '' },
  { id: 'photo', label: tx('ws.001'), hash: '#photo' },
  { id: 'doc', label: tx('ws.002'), hash: '#doc' },
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
  return extOf(item.file.name).toUpperCase() || tx('ws.001');
}
/** 실제로 저장될 형식 (원본 유지인데 원본 형식으로 못 저장하면 자동 형식) */
const effFormat = (item, s = item.settings) => outputFormat(s.format, item.info.type);
const canKeep = (item) => !item.info.type || SAVEABLE.includes(item.info.type);

/* ---------- 설정 정의 ---------- */
const IMAGE_MODES = [
  { id: 'size', label: tx('ws.004'), hint: tx('ws.005') },
  { id: 'balanced', label: tx('ws.006'), hint: tx('ws.007') },
  { id: 'quality', label: tx('ws.008'), hint: tx('ws.009') },
];
const PDF_MODES = [
  { id: 'size', label: tx('ws.004'), hint: tx('ws.010') },
  { id: 'balanced', label: tx('ws.006'), hint: tx('ws.011') },
  { id: 'quality', label: tx('ws.008'), hint: tx('ws.012') },
];
const DOC_MODES = [
  { id: 'size', label: tx('ws.004'), hint: tx('ws.013') },
  { id: 'balanced', label: tx('ws.006'), hint: tx('ws.014') },
  { id: 'quality', label: tx('ws.008'), hint: tx('ws.015') },
];
const RESIZES = [
  { id: 'none', label: tx('ws.016'), hint: tx('ws.017') },
  { id: 'percent', label: tx('ws.018'), hint: tx('ws.019') },
  { id: 'pixels', label: tx('ws.020'), hint: tx('ws.021') },
  { id: 'target', label: tx('ws.022'), hint: tx('ws.023') },
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
  { id: 'same', label: tx('ws.024') },
  { id: 'jpeg', label: 'JPG' },
  { id: 'png', label: tx('ws.025') },
  { id: 'webp', label: 'WebP' },
  { id: 'avif', label: 'AVIF' },   // 이 브라우저가 AVIF 를 열 수 있을 때만 보인다
];
const UNIT = { KB: 1000, MB: 1000 * 1000 };
const MIN_TARGET = 10 * 1000;

/* PDF 나누기 방식 · 합치기 사진 쪽 여백
   ex = 그림 예시(결과 파일마다 쪽 번호) · ph = 범위 입력칸 예시 글(N쪽마다는 숫자 칸이라 없음)
   whole = 아무것도 안 고르면 전체 쪽 대상 (제목 '나눌 범위 (비우면 전체)') */
const SPLIT_METHODS = [
  { id: 'one', label: tx('ws.194'), hint: tx('ws.198'), ex: [[1, 3, 5]], ph: tx('ws.266') },
  { id: 'ranges', label: tx('ws.195'), hint: tx('ws.199'), ex: [[1, 2, 3], [5], [8, 9]], ph: tx('ws.267') },
  { id: 'every', label: tx('ws.196'), hint: tx('ws.200'), ex: [[1, 2], [3, 4], [5]], tag: 'N=2', whole: true },
  { id: 'each', label: tx('ws.197'), hint: tx('ws.201'), ex: [[1], [2], [3]], ph: tx('ws.268'), whole: true },
];
const methodOf = (id) => SPLIT_METHODS.find((m) => m.id === id) || SPLIT_METHODS[0];
/** 방식 그림 예시: 같은 결과 파일 쪽 칸은 같은 색(묶음 번호 → --split-g1~6) → 파일 N개 + 설명 */
const splitExample = (m) => `
  <div class="ws-ex" data-ex="${m.id}" hidden>
    <div class="ws-ex__fig" aria-hidden="true">
      ${m.tag ? `<span class="ws-ex__tag">${m.tag}</span>` : ''}
      ${m.ex.map((g, i) => `<span class="ws-ex__grp" data-gc="${groupColor(i)}">${g.map((p) => `<span class="ws-ex__pg">${p}</span>`).join('')}</span>`).join('')}
      <span class="ws-ex__arrow">→</span>
      <span class="ws-ex__n">${tx('ws.265', { n: m.ex.length })}</span>
    </div>
    <p class="ws-hint">${m.hint}</p>
  </div>`;
const MARGIN_OPTS = [
  { id: 'none', label: tx('ws.239') },
  { id: 'narrow', label: tx('ws.240') },
  { id: 'normal', label: tx('ws.241') },
];
/* 합치기 사진 쪽: 크기 · 방향 (엔진 merge.js 의 size·orient) */
const SIZE_OPTS = [
  { id: 'a4', label: tx('ws.288') },
  { id: 'fit', label: tx('ws.289') },
];
const ORIENT_OPTS = [
  { id: 'auto', label: tx('ws.292') },
  { id: 'portrait', label: tx('ws.293') },
  { id: 'landscape', label: tx('ws.294') },
];
/** 합친 PDF 가 이보다 크면 [이어서 압축하기] 옆에 '제출용이라면 압축을 추천해요' */
const NEXT_HINT_BYTES = 10 * 1000 * 1000;
const PDF_TABS = [
  { id: 'compress', label: tx('ws.190') },
  { id: 'split', label: tx('ws.191') },
];

// bg(JPG 투명 배경 채우기 색)의 기본값은 mount 때 theme.css 의 --jpg-fill-default 에서 읽는다
const DEFAULTS = {
  image: { mode: 'size', resize: 'none', percent: '50', width: '1920', height: '1920', keepRatio: true, target: '1', targetUnit: 'MB', format: 'same', bg: '' },
  // tab: 설정 위 탭 · split: 나누기 설정 (text = 쪽 범위 글이 '고른 쪽'의 기준 — 썸네일 선택은 이 글을 고친다)
  pdf: { mode: 'size', tab: 'compress', split: { method: 'one', text: '', every: '2' } },
  doc: { mode: 'size' },
};
const baseName = (name) => name.replace(/\.[^.]+$/, '');

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

/** 나누기 설정 → 엔진 옵션 (쪽 범위 글은 정리된 모양으로 — 같은 뜻이면 같은 키라 '설정 바뀜'이 정확하다) */
function splitOptions(item, s = item.settings) {
  const sp = s.split;
  const total = item.info.pages || Infinity;
  const o = { engine: 'split', method: sp.method, base: baseName(item.file.name) };
  // 고른 쪽 (N쪽마다·한 쪽씩은 비어 있으면 전체 쪽)
  if (sp.method === 'ranges') o.text = parseRanges(sp.text, total).groups.map((g) => formatRanges(g)).join(', ');
  else o.text = formatRanges(parseRanges(sp.text, total).pages);
  if (sp.method === 'every') o.every = int(sp.every);
  return o;
}
/** PDF 에서 지금 보고 있는 탭 */
const pdfTab = (item) => (item && item.kind === 'pdf' ? item.settings.tab || 'compress' : null);

/** 설정 확인: { text, block } — block 이면 적용 불가 */
function checkSettings(kind, s) {
  if (kind !== 'image') return null;
  if (s.resize === 'percent' && num(s.percent) > 100) return { text: tx('ws.026'), block: false };
  if (s.resize === 'percent' && !int(s.percent)) return { text: tx('ws.027'), block: true };
  if (s.resize === 'pixels' && !int(s.width) && !int(s.height)) return { text: tx('ws.028'), block: true };
  if (s.resize === 'target' && !targetBytes(s)) return { text: tx('ws.029'), block: true };
  if (s.resize === 'target' && targetBytes(s) < MIN_TARGET) return { text: tx('ws.030'), block: true };
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
  title: tx('ws.031'),
  icon: icon('logo', 16),

  mount(container) {
    loadCss('css/apps/workspace.css');
    container.innerHTML = template(currentLimits());
    const $ = (sel) => container.querySelector(sel);

    const state = { items: [], nextId: 1, selectedId: null };
    // 작업 번호 → { item, track }. track: 'main' = 압축 등 항목 자체 처리 · 'split' = 나누기 · 'merge' = 합치기(item 없음)
    const jobs = new Map();
    let jobSeq = 0;
    const picked = new Set();   // 합치기용 체크박스로 고른 항목 id
    let merge = null;           // 합치기 화면이 열려 있으면 { order:[id], margin, name, job, status, pct, stage, error }
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
          excluded.push({ file, why: 'doc', text: tx('ws.032', { p: mbText(lim.maxDocFile) }) });
        } else if (kind === 'pdf' && r && r.risk > lim.pdf) {
          excluded.push({ file, why: 'pdf', text: tx('ws.033', { p: mbText(lim.maxPdfFile) }) });
        } else if (kind === 'image' && r && r.risk > lim.photo) {
          excluded.push(r.byHeader
            ? { file, why: 'photo', text: tx('ws.034', { width: r.width, height: r.height, p: mpText(r.width * r.height), p1: mpText(lim.maxPixels) }) }
            : { file, why: 'photo', text: tx('ws.035', { p: mbText(lim.maxPhotoFile) }) });
        } else if (count + 1 > lim.count) {
          excluded.push({ file, why: 'list', text: tx('ws.036', { count: lim.count }) });
        } else if (total + file.size > lim.total) {
          excluded.push({ file, why: 'list', text: tx('ws.037', { p: mbText(lim.total) }) });
        } else {
          count++;
          total += file.size;
          ok.push(file);
        }
      });
      addItems(ok);
      if (excluded.length) showExcluded(excluded, ok.length);
    }

    function makeItem(file, kind) {
      const item = {
        id: state.nextId++, file, kind,
        settings: structuredClone(DEFAULTS[kind]),
        applied: null, job: null,
        status: 'idle', pct: 0, stage: '',
        result: null, blob: null, outUrl: null, origUrl: null, thumbUrl: null, previewUrl: null,
        previews: {}, info: {}, exported: false, notice: false,
        probing: kind !== 'pdf', // 사진·문서는 실제로 열리는지 확인이 끝나야 설정·적용 가능
        made: null,              // 나누기·합치기로 만든 파일이면 { by: 'split'|'merge', from?: 원본 id, fromName? }
        // PDF 나누기 탭의 상태 (압축 결과와 따로) — result = { pages, counts, size, partIds, lost }
        split: kind === 'pdf' ? { job: null, applied: null, status: 'idle', pct: 0, stage: '', result: null, notice: false } : null,
        pageThumbs: null,        // 나누기 화면 쪽 썸네일 Map(n → { blob, url })
      };
      item.el = createRow(item);
      return item;
    }

    function addItems(files) {
      const added = [];
      rejected = { unsupported: [], broken: [], network: [] };
      dropMsg.textContent = '';
      for (const file of files) {
        const kind = kindOf(file);
        const item = makeItem(file, kind);
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

    /**
     * 나누기·합치기로 만든 PDF 를 목록에 넣는다 (한도 검사는 만들기 전에 했다).
     * after = 이 항목 바로 아래에(나눈 파일은 원본 아래 차례로) · thumb = 이미 그린 첫 쪽 썸네일 Blob
     */
    function addMade(file, made, { pages, after = null, thumb = null } = {}) {
      const item = makeItem(file, 'pdf');
      item.made = made;
      item.info.pages = pages;
      const idx = after ? state.items.indexOf(after) : -1;
      if (idx >= 0) {
        let at = idx + 1;
        while (at < state.items.length && state.items[at].made && state.items[at].made.from === after.id) at++;
        state.items.splice(at, 0, item);
        const next = state.items[at + 1];
        list.insertBefore(item.el, next ? next.el : null);
      } else {
        state.items.push(item);
        list.appendChild(item.el);
      }
      if (thumb) setThumb(item, URL.createObjectURL(thumb));
      else listIO.observe(item.el);   // 목록에 보일 때만 그린다 (100개로 나눠도 그리기 줄이 밀리지 않게)
      renderRow(item);
      return item;
    }
    const listIO = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        listIO.unobserve(en.target);
        const item = state.items.find((it) => it.el === en.target);
        if (item && !item.thumbUrl) madeThumb(item);
      }
    }, { rootMargin: '200px 0px' });
    function setThumb(item, url) {
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      item.thumbUrl = url;
      item.el.querySelector('.ws-item__thumb img').src = url;
    }
    /** 만든 PDF 의 목록 썸네일: 첫 쪽만 작게 (큰 미리보기는 고를 때 따로) */
    async function madeThumb(item) {
      const alive = () => state.items.includes(item);
      // 나눈 파일: 원본 문서가 나누기 화면에 열려 있으면 그 문서에서 첫 쪽만 (새로 열지 않음)
      const src = item.made && item.made.from ? state.items.find((it) => it.id === item.made.from) : null;
      const blob = src && item.made.first ? await grid.pageBlob(src, item.made.first, 128).catch(() => null) : null;
      if (blob) { if (alive()) setThumb(item, URL.createObjectURL(blob)); return; }
      if (!previewLib) previewLib = import('../engines/pdf/preview.js');
      const r = await (await previewLib).renderFirstPage(item.file, 128, false, alive).catch(() => null);
      if (!r) return;
      if (!alive()) { URL.revokeObjectURL(r.url); return; }
      setThumb(item, r.url);
    }

    /* ---------- 올리지 못한 파일 안내 팝업 (모달) ---------- */
    const modal = $('.ws-modal');
    let modalReturn = null;
    const FIXES = {
      photo: tx('ws.038'),
      pdf: tx('ws.039'),
      doc: tx('ws.040'),
      docsig: tx('ws.041'),
      list: tx('ws.042'),
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
        ? tx('ws.043', { excludedCount: excluded.length, addedCount })
        : tx('ws.044', { excludedCount: excluded.length });
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
      const names = (arr) => arr.slice(0, 3).join(', ') + (arr.length > 3 ? tx('ws.045', { p: arr.length - 3 }) : '');
      const lines = [];
      if (rejected.unsupported.length) lines.push(tx('ws.046', { SUPPORTED_TEXT, p: names(rejected.unsupported) }));
      if (rejected.broken.length) lines.push(tx('ws.047', { p: names(rejected.broken) }));
      if (rejected.network.length) lines.push(tx('ws.048', { p: names(rejected.network) }));
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
        // 원본 첫 페이지를 그릴 때 목록용 작은 썸네일(긴 변 128px)도 같이 만든다 (만든 PDF 는 썸네일을 따로 그림)
        item.previews[which] = pdfPreview(src, which === 'before' && !item.made).catch((err) => {
          if (!err || err.name !== 'PasswordException') console.warn(err); // 암호 PDF 는 미리보기 없음 (안내는 적용 시)
          // 열 때 암호를 묻는 PDF 는 여기서 알 수 있다 → 합치기에서 미리 빼고 안내
          else if (which === 'before' && !item.info.encrypted) { item.info.encrypted = true; renderRow(item); renderPickbar(); }
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
        if (item.id === state.selectedId) { renderSettings(); renderView(); }   // 나누기 화면은 쪽 수를 알아야 그린다
        if (merge) renderMerge();
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
      renderPickbar();   // 형식 확인이 끝나야 합치기에 고를 수 있다
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

    /** track: 'main'(항목 자체 처리) | 'split'(나누기 탭) — 각자 job·status·pct·stage 를 따로 갖는다 */
    const trackOf = (item, track) => (track === 'split' ? item.split : item);

    function stopJob(item, track = 'main') {
      const t = trackOf(item, track);
      if (!t || t.job == null) return;
      pool.abort(t.job);
      jobs.delete(t.job);
      t.job = null;
    }

    function start(item, options) {
      stopJob(item);
      clearResult(item);
      item.applied = options;
      item.job = ++jobSeq;
      jobs.set(item.job, { item, track: 'main' });
      item.status = 'queued';
      item.pct = 0;
      item.stage = tx('ws.049');
      pool.add({ id: item.job, file: item.file, options });
    }

    function applyTo(item) {
      if (pdfTab(item) === 'split') return startSplit(item);
      const chk = checkSettings(item.kind, item.settings);
      if ((chk && chk.block) || item.probing) return false;
      start(item, toOptions(item));
      return true;
    }

    function revert(item) {
      if (pdfTab(item) === 'split') { clearSplit(item); return; }
      stopJob(item);
      clearResult(item);
      item.applied = null;
      item.status = 'idle';
      item.pct = 0;
      item.stage = '';
    }

    /* ---------- 나누기 (나누기 탭 전용 상태 — 압축 결과는 건드리지 않는다) ---------- */
    /** 나누기에 쓸 PDF: 압축 결과가 있으면 그 결과, 없으면 원본 (이어서 작업) */
    const workBlob = (item) => (item.status === 'done' && item.result && item.result.kind !== 'original' && item.blob ? item.blob : item.file);

    function startSplit(item) {
      const chk = splitCheck(item);
      if (chk && chk.block) return false;
      const sp = item.split;
      stopJob(item, 'split');
      const options = splitOptions(item);
      sp.applied = keyOf(options);
      sp.job = ++jobSeq;
      jobs.set(sp.job, { item, track: 'split' });
      Object.assign(sp, { status: 'queued', pct: 0, stage: tx('ws.049'), notice: false });
      pool.add({ id: sp.job, file: workBlob(item), options });
      return true;
    }
    /** 이 PDF 에서 나눈 파일을 목록에서 지운다 (다시 나누기·나눈 결과 지우기) */
    function removeParts(item) {
      // 원본이 스스로 바꾸는 중(다시 나누기·나눈 파일 지우기)이라 지울 때마다 원본 상태를 고치지 않게 결과를 먼저 떼어 둔다 (forgetPart)
      item.split.result = null;
      for (const it of [...state.items]) if (it.made && it.made.by === 'split' && it.made.from === item.id) removeItem(it.id, { quiet: true });
    }
    function clearSplit(item) {
      stopJob(item, 'split');
      removeParts(item);
      Object.assign(item.split, { applied: null, status: 'idle', pct: 0, stage: '', result: null, notice: false });
    }
    function onSplitDone(item, r) {
      removeParts(item);
      const ids = [];
      r.parts.forEach((p) => {
        const file = new File([p.bytes], p.name, { type: 'application/pdf' });
        const cached = item.pageThumbs && item.pageThumbs.get(p.first);
        const it = addMade(file, { by: 'split', from: item.id, fromName: item.file.name, first: p.first }, { pages: p.pages, after: item, thumb: cached ? cached.blob : null });
        ids.push(it.id);
      });
      item.split.result = { pages: r.pages, counts: r.parts.map((p) => p.pages), size: r.size, partIds: ids, lost: r.lost };
      renderAll();
    }

    function onWorkerMessage(msg) {
      const ref = jobs.get(msg.id);
      if (!ref) return; // 지워졌거나 다시 적용된 작업
      if (ref.track === 'merge') { onMergeMessage(msg); return; }
      const { item } = ref;
      const t = trackOf(item, ref.track);
      if (t.job !== msg.id) return;
      if (msg.type === 'thumb') return; // 썸네일은 썸네일 워커가 만든다
      if (msg.type === 'progress') {
        t.status = 'working';
        t.pct = msg.pct;
        t.stage = msg.stage;
        renderRow(item);
        if (item.id === state.selectedId) renderProgress(item);
        return;
      }
      jobs.delete(msg.id);
      t.job = null;
      if (msg.code === 'encrypted') item.info.encrypted = true;   // 합치기 고를 때 미리 알린다
      if (ref.track === 'split') {
        if (msg.type === 'done') {
          Object.assign(t, { status: 'done', pct: 1 });
          onSplitDone(item, msg.result);
        } else {
          Object.assign(t, { status: 'error', notice: !!msg.notice, stage: msg.message || tx('ws.050') });
          afterChange(item);
        }
        return;
      }
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
        item.stage = msg.message || tx('ws.050');
      }
      afterChange(item);
    }

    function onWorkerCrash(jobId) {
      const ref = jobs.get(jobId);
      jobs.delete(jobId);
      if (!ref) return;
      if (ref.track === 'merge') { onMergeMessage({ id: jobId, type: 'error', message: tx('ws.052') }); return; }
      const { item } = ref;
      const t = trackOf(item, ref.track);
      if (t.job !== jobId) return;
      t.job = null;
      t.status = 'error';
      t.notice = false;
      t.stage = item.kind === 'image' ? tx('ws.051') : tx('ws.052');
      afterChange(item);
    }

    function afterChange(item) {
      renderRow(item);
      if (item.id === state.selectedId) { renderSettings(); renderView(); }
      renderSummary();
      renderPickbar();
    }

    /* ===================== 목록 ===================== */
    function createRow(item) {
      const li = document.createElement('li');
      li.className = 'ws-item';
      li.dataset.id = item.id;
      li.dataset.kind = item.kind;
      // 합치기 고르기 체크박스: PDF·사진만 (문서는 합칠 수 없음)
      li.innerHTML = `
        <label class="ws-item__pick">
          <input type="checkbox" data-act="pick"><span class="sr-only">${tx('ws.228')}</span>
        </label>
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
          <a class="btn btn--icon" data-act="download" title="${tx('ws.053')}">${icon('download', 18)}<span class="sr-only">${tx('ws.053')}</span></a>
          <button type="button" class="btn btn--icon" data-act="remove" title="${tx('ws.054')}">${icon('close', 18)}<span class="sr-only">${tx('ws.054')}</span></button>
        </div>`;
      li.querySelector('.ws-item__name').textContent = item.file.name;
      li.querySelector('.ws-item__name').title = item.file.name;
      li.querySelector('.ws-tag').textContent = srcLabel(item);
      li.querySelector('.ws-item__orig').textContent = formatBytes(item.file.size);
      return li;
    }

    function statusOf(item) {
      if (item.probing) return { text: tx('ws.055'), tone: 'busy' };
      // 나누는 중이면 (압축이 돌고 있지 않을 때) 나누기 진행을 보여 준다
      const sp = item.split;
      if (sp && (sp.status === 'queued' || sp.status === 'working') && item.status !== 'queued' && item.status !== 'working') {
        return sp.status === 'queued' ? { text: tx('ws.049'), tone: 'busy' } : { text: tx('ws.192', { p: Math.round(sp.pct * 100) }), tone: 'busy' };
      }
      if (item.made && item.status === 'idle') return { text: item.made.by === 'merge' ? tx('ws.259') : tx('ws.258'), tone: 'good' };
      switch (item.status) {
        case 'queued': return { text: tx('ws.049'), tone: 'busy' };
        case 'working': return { text: tx('ws.056', { p: Math.round(item.pct * 100) }), tone: 'busy' };
        case 'done': return isKept(item) ? { text: tx('ws.024'), tone: 'kept' } : { text: tx('ws.057'), tone: 'good' };
        case 'error': return item.notice ? { text: tx('ws.058'), tone: 'warn' } : { text: tx('ws.059'), tone: 'danger' };
        default: return { text: tx('ws.060'), tone: 'muted' };
      }
    }
    const isDirty = (item) => !!item.applied && keyOf(toOptions(item)) !== keyOf(item.applied);
    const isSplitDirty = (item) => !!(item.split && item.split.applied) && keyOf(splitOptions(item)) !== item.split.applied;
    /** 합칠 수 있는 항목 (PDF·사진, 형식 확인 끝, 암호 아님). 문서·암호 PDF 는 체크해도 빼고 목록 위에 안내 */
    const mergeable = (item) => (item.kind === 'pdf' || item.kind === 'image') && !item.probing && !item.info.encrypted;
    /** 원본 유지 = 결과가 원본과 같은 바이트(엔진이 kind 'original' 로 돌려줌) */
    const isKept = (item) => item.status === 'done' && !!item.result && item.result.kind === 'original';
    // 원본 유지 파일은 줄지 않았으므로 _min 을 붙이지 않고 원래 이름 그대로
    const outName = (item) => (isKept(item) ? item.file.name : renameExt(item.file.name, item.result.ext, '_min'));
    /**
     * 내보낼 것: 처리 결과(원본 유지 제외) — 없으면 나누기·합치기로 만든 파일 그 자체.
     * @returns {{ blob, name, url() } | null}
     */
    function productOf(item) {
      if (item.status === 'done' && item.result && !isKept(item)) return { blob: item.blob, name: outName(item), url: () => item.outUrl };
      if (item.made) return { blob: item.file, name: item.file.name, url: () => origUrlOf(item) };
      return null;
    }

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
      // 원본 유지는 회색 배지 (감소율 배지는 띄우지 않음)
      stEl.className = st.tone === 'kept' ? 'ws-status ws-badge ws-badge--muted' : `ws-status ws-status--${st.tone}`;
      const out = el.querySelector('.ws-item__out');
      out.textContent = '';
      const r = item.result;
      if (item.status === 'done' && r) {
        if (r.kind === 'original') {
          // 상태 배지가 '원본 유지'를 보여 주므로 결과 칸은 비운다
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
      if (item.split && item.split.status === 'done' && item.split.result) {
        const s = document.createElement('span');
        s.className = 'ws-item__fmt';
        s.textContent = tx('ws.220', { n: item.split.result.partIds.length });
        out.append(s);
      }
      if (isDirty(item)) {
        const d = document.createElement('span');
        d.className = 'ws-item__dirty';
        d.textContent = tx('ws.061');
        out.append(d);
      }
      const busyTrack = item.status === 'working' || item.status === 'queued' ? item
        : item.split && (item.split.status === 'working' || item.split.status === 'queued') ? item.split : null;
      el.dataset.status = busyTrack ? busyTrack.status : item.status;
      el.querySelector('.ws-progress').hidden = !busyTrack;
      el.querySelector('.ws-tag').textContent = srcLabel(item);
      el.querySelector('.ws-progress span').style.width = gauge(busyTrack ? busyTrack.pct : item.pct);
      // 합치기 고르기: 형식 확인 중에만 잠근다. 문서·암호 PDF 는 체크할 수 있지만 합칠 때 빠진다(목록 위 안내)
      const pick = el.querySelector('[data-act="pick"]');
      pick.checked = picked.has(item.id);
      pick.disabled = !!item.probing;
      el.querySelector('.ws-item__pick').title = item.kind === 'doc' ? tx('ws.276')
        : item.info.encrypted ? tx('ws.251', { name: item.file.name }) : tx('ws.228');
      const label = item.info.width ? `${item.info.width}×${item.info.height}` : item.info.pages ? tx('ws.062', { pages: item.info.pages })
        : item.kind === 'doc' && item.info.images !== undefined ? tx('ws.063', { images: item.info.images }) : '';
      el.querySelector('.ws-item__orig').textContent = [formatBytes(item.file.size), label].filter(Boolean).join(' · ');
      const dl = el.querySelector('[data-act="download"]');
      const prod = productOf(item);
      if (prod || (item.status === 'done' && r)) {
        dl.href = prod ? prod.url() : origUrlOf(item);
        dl.download = prod ? prod.name : item.file.name;
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
      if (act === 'remove') focusAfterRemove(removeItem(id));   // 지운 버튼과 함께 포커스가 사라지지 않게
      if (act === 'download') {
        if (!btn.getAttribute('href')) { e.preventDefault(); return; }
        markExported(id);
      }
    });
    // 합치기 고르기 (체크박스)
    list.addEventListener('change', (e) => {
      if (!e.target.matches('[data-act="pick"]')) return;
      const id = Number(e.target.closest('.ws-item').dataset.id);
      if (e.target.checked) picked.add(id); else picked.delete(id);
      if (merge) syncMergeOrder();
      renderPickbar();
      if (merge) renderMerge();
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
      msg.textContent = none ? tx('ws.064', { p: FILTERS.find((x) => x.id === filter).label }) : '';
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

    /**
     * 목록에서 지우기. 처리 중인 작업·썸네일 대기는 취소하고, 그 파일의 object URL 은 모두 해제한다.
     *  · 지운 파일이 선택돼 있었으면 다른 파일을 고르지 않고 설정·결과 칸을 처음 빈 상태로 (지운 파일 상태가 남지 않게)
     *  · 나눈 파일이면 원본 PDF 의 나누기 결과에서 뺀다 (forgetPart)
     *  · 합치기 화면이 열려 있으면 순서 목록에서도 빼고, 2개 미만이 되면 화면을 닫는다
     * quiet = 여러 개를 한꺼번에 지우는 중이라 화면은 부른 쪽이 한 번에 다시 그린다.
     * @returns {number} 지운 자리(목록 순서) — 포커스를 옮길 때 쓴다. 없으면 -1
     */
    function removeItem(id, { quiet = false } = {}) {
      const idx = state.items.findIndex((it) => it.id === id);
      if (idx < 0) return -1;
      const [item] = state.items.splice(idx, 1);
      stopJob(item);
      if (item.split) stopJob(item, 'split');
      thumbs.cancel(item.id);
      listIO.unobserve(item.el);
      item.el.remove();
      if (grid.item === item) grid.reset();
      revokeAll(item);
      picked.delete(id);
      forgetPart(item);
      if (state.selectedId === id) state.selectedId = null;
      if (merge) {
        syncMergeOrder();
        // 남은 파일이 2개 미만이면 합치기 화면을 닫고 빈 상태로 (이미 돌고 있는 합치기는 끝까지 둔다)
        if (merge.order.length < 2 && !mergeBusy()) { merge = null; state.selectedId = null; }
      }
      if (!quiet) renderAll();
      return idx;
    }

    /** 나눈 파일을 지우면 원본 PDF 의 나누기 결과에서도 뺀다. 다 지웠으면 원본은 '나누기 전' 상태로 (다시 나눌 수 있게) */
    function forgetPart(part) {
      if (!part.made || part.made.by !== 'split') return;
      const src = state.items.find((it) => it.id === part.made.from);
      const r = src && src.split.result;
      const i = r ? r.partIds.indexOf(part.id) : -1;
      if (i < 0) return;
      r.partIds.splice(i, 1);
      r.counts.splice(i, 1);
      r.size = Math.max(0, r.size - part.file.size);
      // 다 지웠고 다시 나누는 중이 아니면 '나누기 전'으로 (나누는 중이면 새 결과가 곧 덮어쓴다)
      if (!r.partIds.length && src.split.job == null) Object.assign(src.split, { applied: null, status: 'idle', pct: 0, stage: '', result: null, notice: false });
      if (src.el.isConnected) renderRow(src);
    }

    /** 지운 뒤 키보드 포커스: 그 자리의 다음 파일(없으면 앞 파일, 그것도 없으면 업로드 상자) — 고르지는 않고 포커스만 */
    function focusAfterRemove(idx) {
      const visible = (it) => !it.el.hidden;
      const next = state.items.slice(Math.max(0, idx)).find(visible) || state.items.slice(0, Math.max(0, idx)).reverse().find(visible);
      (next ? next.el.querySelector('.ws-item__main') : drop).focus();
    }

    function revokeAll(item) {
      clearResult(item);
      dropPreview(item, 'before');
      if (item.origUrl) URL.revokeObjectURL(item.origUrl);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      item.origUrl = item.thumbUrl = item.previewUrl = null;
      if (item.pageThumbs) { item.pageThumbs.forEach((t) => URL.revokeObjectURL(t.url)); item.pageThumbs = null; }
    }

    // 모두 지우기: 한꺼번에 지우고(돌고 있는 합치기도 멈춤) 모든 칸을 처음 상태로 한 번에 다시 그린다
    $('[data-act="clear"]').addEventListener('click', () => {
      if (!state.items.length) return;
      if (unsavedCount() && !confirm(tx('ws.065'))) return;
      if (merge && merge.job != null) { pool.abort(merge.job); jobs.delete(merge.job); }
      merge = null;
      [...state.items].forEach((it) => removeItem(it.id, { quiet: true }));
      picked.clear();
      state.selectedId = null;
      renderAll();
      drop.focus();
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
    const splitSet = $('.ws-set[data-kind="split"]');
    const mergeSet = $('.ws-set[data-kind="merge"]');
    const tabsEl = $('.ws-tabs');
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
      keepOpt.textContent = !item.info.type ? tx('ws.024')
        : can ? tx('ws.066', { p: srcLabel(item) }) : tx('ws.067', { p: srcLabel(item) });
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
        if (t === 'heic') lines.push(tx('ws.068', { name }));
        else if (t === 'avif') lines.push(tx('ws.069'));
        else if (t === 'bmp' || t === 'tiff') lines.push(tx('ws.070', { name }));
        else lines.push(tx('ws.071', { name }));
      }
      if (item.info.animated && (t === 'gif' || eff !== t)) {
        lines.push(t === 'gif' ? tx('ws.072') : tx('ws.073'));
      }
      if (LOSSY_SOURCES.includes(t) && eff === 'png') {
        lines.push(tx('ws.074'));
      } else if (t && SAVEABLE.includes(t) && eff !== t) {
        lines.push(tx('ws.075'));
      }
      if (eff === 'avif') lines.push(tx('ws.076'));
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
        ? tx('ws.077')
        : isPng ? tx('ws.078')
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
      if (!item || item.probing) cnt.textContent = tx('ws.079');
      else if (item.info.secure) cnt.textContent = item.info.secure;
      else {
        const n = item.info.images || 0, m = item.info.compressible || 0;
        cnt.textContent = n === 0 ? tx('ws.080')
          : tx('ws.081', { n }) + (m < n ? tx('ws.082', { m }) : '');
      }
      cnt.classList.toggle('ws-hint--warn', !!(item && item.info.secure));
    }
    const readDoc = () => ({ mode: docSet.querySelector('input[name="ws-mode-doc"]:checked').value });

    function onSettingsInput() {
      const item = selected();
      if (!item) return;
      if (item.kind === 'image') { item.settings = readImage(); syncImage(item.settings); }
      else if (item.kind === 'doc') { item.settings = readDoc(); fillDoc(item.settings); }
      else { item.settings = { ...item.settings, ...readPdf() }; fillPdf(item.settings); }
      renderActions(item);
      renderRow(item);
    }

    /* ---------- PDF 탭 [압축] [나누기] ---------- */
    function setTab(item, tab, { focus = false } = {}) {
      if (!item || item.kind !== 'pdf' || pdfTab(item) === tab) return;
      item.settings.tab = tab;
      renderSettings();
      renderView();
      if (focus) tabsEl.querySelector(`[data-tab="${tab}"]`).focus();
    }
    tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) setTab(selected(), b.dataset.tab);
    });
    tabsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      const item = selected();
      if (!item) return;
      e.preventDefault();
      const ids = PDF_TABS.map((t) => t.id);
      const i = ids.indexOf(pdfTab(item));
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
      setTab(item, ids[next], { focus: true });
    });

    /* ---------- 나누기 설정 ---------- */
    const rangeInput = splitSet.querySelector('#ws-range-text');
    const everyInput = splitSet.querySelector('#ws-every');
    const grid = new PageGrid(splitSet.querySelector('.ws-pages'), {
      open: async (item) => {
        if (!previewLib) previewLib = import('../engines/pdf/preview.js');
        return (await previewLib).openPages(item.file);
      },
      onFail: (item) => {
        item.info.pagesFailed = true;
        if (item.id === state.selectedId) fillSplit(item);
      },
      onPick: ({ pages, select: on }) => {
        const item = selected();
        if (!item) return;
        const set = new Set(parseRanges(item.settings.split.text, item.info.pages || Infinity).pages);
        pages.forEach((p) => (on ? set.add(p) : set.delete(p)));
        item.settings.split.text = formatRanges([...set]);
        rangeInput.value = item.settings.split.text;
        syncSplit(item);
      },
    });

    /**
     * 나누기 확인: { text, block, tone } — tone 'danger' = 잘못된 입력(빨간 안내) · 'warn' = 아직 안 고름 · 'muted' = 기다리는 중
     * (쪽 수를 모르면 아직 막는다 — 미리보기를 못 만든 PDF 는 워커가 확인)
     */
    function splitCheck(item, s = item.settings) {
      const sp = s.split;
      const total = item.info.pages;
      if (!total && !item.info.previewFailed && !item.info.pagesFailed) return { text: tx('ws.213'), block: true, tone: 'muted' };
      const T = total || Infinity;
      const { pages, bad, missing } = parseRanges(sp.text, T);
      if (missing.length) {
        const worst = Math.max(...missing.filter((p) => p > 0), 0) || 0;
        return { text: tx('ws.272', { p: worst, total: total || '?' }), block: true, tone: 'danger' };
      }
      if (bad.length) return { text: tx('ws.273', { p: bad[0] }), block: true, tone: 'danger' };
      if (sp.method === 'every' && !int(sp.every)) return { text: tx('ws.210'), block: true, tone: 'danger' };
      if (!methodOf(sp.method).whole && !pages.length) return { text: tx('ws.209'), block: true, tone: 'warn' };
      const lim = currentLimits();
      const n = splitGroups(sp, T).length;
      if (n > lim.splitParts) return { text: tx('ws.211', { n, max: lim.splitParts }), block: true, tone: 'danger' };
      const sum = state.items.reduce((acc, it) => acc + it.file.size, 0);
      if (sum + item.file.size > lim.total) return { text: tx('ws.212', { p: mbText(lim.total) }), block: true, tone: 'danger' };
      return null;
    }

    function fillSplit(item) {
      const sp = item.settings.split;
      splitSet.querySelectorAll('input[name="ws-split"]').forEach((r) => { r.checked = r.value === sp.method; });
      rangeInput.value = sp.text;
      everyInput.value = sp.every;
      const total = item.info.pages;
      const msg = splitSet.querySelector('.ws-pages__msg');
      if (total) {
        grid.show(item, total);
        msg.textContent = item.info.pagesFailed ? tx('ws.216') : '';
      } else {
        grid.reset();
        msg.textContent = item.info.previewFailed || item.info.pagesFailed ? tx('ws.216') : tx('ws.213');
      }
      splitSet.querySelector('.ws-pages').hidden = !total || !!item.info.pagesFailed;
      splitSet.querySelector('.ws-split__total').textContent = total ? tx('ws.062', { pages: total }) : '';
      syncSplit(item);
    }
    /** 방식·고른 쪽이 바뀔 때마다: 그림 예시·제목·입력칸·썸네일 묶음·결과 미리보기를 한 번에 맞춘다 */
    function syncSplit(item) {
      const sp = item.settings.split;
      const m = methodOf(sp.method);
      // 그림 예시 + 설명
      splitSet.querySelectorAll('.ws-ex').forEach((ex) => { ex.hidden = ex.dataset.ex !== m.id; });
      // '쪽 고르기' ↔ '나눌 범위 (비우면 전체)' · 입력칸 (N쪽마다는 범위 칸 대신 숫자 칸)
      splitSet.querySelector('.ws-split__ptitle').textContent = m.whole ? tx('ws.269') : tx('ws.206');
      rangeInput.hidden = m.id === 'every';
      if (m.ph) rangeInput.placeholder = m.ph;
      rangeInput.setAttribute('aria-label', m.whole ? tx('ws.269') : tx('ws.206'));
      splitSet.querySelector('.ws-split__every').hidden = m.id !== 'every';
      // 썸네일: 고른 쪽 · 같은 결과 파일 묶음(범위마다 따로·N쪽마다) · 비었으면 전체가 옅게(N쪽마다·한 쪽씩)
      const total = item.info.pages || Infinity;
      const picked = new Set(parseRanges(sp.text, total).pages);
      const groups = splitGroups(sp, total);
      let byPage = null;
      const chk = splitCheck(item);
      // 잘못된 입력이면 묶음 색은 그리지 않는다 (예: 0쪽마다 → 엉뚱한 묶음)
      if ((m.id === 'ranges' || m.id === 'every') && !(chk && chk.tone === 'danger')) {
        byPage = new Map();
        groups.forEach((g, i) => g.forEach((p) => { if (!byPage.has(p)) byPage.set(p, i); }));
      }
      grid.paint({
        pressed: picked, groups: byPage, faint: m.whole && !picked.size, colorOf: groupColor,
        label: (n, g) => (g === undefined ? tx('ws.062', { pages: n }) : tx('ws.275', { pages: n, g: g + 1 })),
      });
      renderPlan(item, groups, chk);
      renderActions(item);
      renderRow(item);
    }

    /**
     * 결과 미리보기: "만들어질 파일 N개" + 번호 배지·파일 이름(가운데 말줄임)·쪽 수.
     * 5개가 넘으면 처음 4개 + "… 외 N개". 입력이 잘못됐거나 아직 못 고르면 그 자리에 안내.
     */
    const PLAN_SHOW = 5;
    function renderPlan(item, groups, chk) {
      const plan = splitSet.querySelector('.ws-plan');
      const head = splitSet.querySelector('.ws-plan__head');
      const msg = splitSet.querySelector('.ws-plan__msg');
      const ok = !chk;   // 안내가 있으면(잘못된 입력·아직 안 고름·쪽 수 확인 중) 목록 대신 안내만
      plan.textContent = '';
      msg.textContent = chk ? chk.text : '';
      msg.dataset.tone = chk ? chk.tone : '';
      // 쪽 수를 모르는 PDF(미리보기 실패)에서 전체 쪽 대상이면 개수를 미리 알 수 없다
      const known = groups.length > 0;
      head.hidden = !ok || !known;
      plan.hidden = !ok || !known;
      if (!ok || !known) return;
      head.textContent = tx('ws.270', { n: groups.length });
      const base = baseName(item.file.name);
      const shown = groups.length > PLAN_SHOW ? groups.slice(0, PLAN_SHOW - 1) : groups;
      shown.forEach((g, i) => {
        const li = document.createElement('li');
        li.className = 'ws-plan__item';
        li.innerHTML = '<span class="ws-plan__badge" aria-hidden="true"></span><span class="ws-plan__name"><span class="ws-plan__base"></span><span class="ws-plan__tail"></span></span><span class="ws-plan__pages"></span>';
        const badge = li.querySelector('.ws-plan__badge');
        badge.textContent = i + 1;
        badge.dataset.gc = groupColor(i);
        // 가운데 말줄임: 원래 이름 부분만 줄이고 _p1-3.pdf 는 끝까지 보인다
        li.querySelector('.ws-plan__base').textContent = base;
        li.querySelector('.ws-plan__tail').textContent = `_p${fileLabel(g)}.pdf`;
        li.querySelector('.ws-plan__name').title = `${base}_p${fileLabel(g)}.pdf`;
        li.querySelector('.ws-plan__pages').textContent = tx('ws.062', { pages: g.length });
        plan.append(li);
      });
      if (shown.length < groups.length) {
        const li = document.createElement('li');
        li.className = 'ws-plan__more';
        li.textContent = tx('ws.271', { n: groups.length - shown.length });
        plan.append(li);
      }
    }
    function onSplitInput(e) {
      const item = selected();
      if (!item || item.kind !== 'pdf') return;
      if (e && e.target === rangeInput && e.type === 'change') {
        // 입력을 마치면 범위 글을 정리된 모양으로 ('범위마다 따로'는 묶음 그대로)
        const total = item.info.pages || Infinity;
        const r = parseRanges(rangeInput.value, total);
        if (!r.bad.length && r.groups.length) {
          rangeInput.value = item.settings.split.method === 'ranges'
            ? r.groups.map((g) => formatRanges(g)).join(', ') : formatRanges(r.pages);
        }
      }
      // N쪽마다: 입력을 마쳤는데 비었거나 1 미만이면 기본 2쪽으로
      if (e && e.target === everyInput && e.type === 'change' && !int(everyInput.value)) everyInput.value = DEFAULTS.pdf.split.every;
      item.settings.split = {
        method: splitSet.querySelector('input[name="ws-split"]:checked').value,
        text: rangeInput.value,
        every: everyInput.value,
      };
      syncSplit(item);
    }
    splitSet.addEventListener('input', onSplitInput);
    splitSet.addEventListener('change', onSplitInput);
    splitSet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pages]');
      const item = selected();
      if (!b || !item || !item.info.pages) return;
      item.settings.split.text = b.dataset.pages === 'all' ? `1-${item.info.pages}` : '';
      if (item.info.pages === 1 && b.dataset.pages === 'all') item.settings.split.text = '1';
      rangeInput.value = item.settings.split.text;
      syncSplit(item);
    });
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

    /**
     * 아무 파일도 고르지 않은 처음 상태: 숨은 칸에 남은 앞 파일의 값(쪽 범위·N쪽·결과 미리보기·안내·합치기 순서)도 비운다.
     * (다음에 파일을 고르면 그 파일의 설정으로 다시 채워지지만, 지운 파일의 흔적은 남기지 않는다)
     */
    function clearSettingsLeftovers() {
      grid.reset();
      rangeInput.value = '';
      everyInput.value = '';
      splitSet.querySelector('.ws-plan').textContent = '';
      splitSet.querySelector('.ws-plan__head').textContent = '';
      splitSet.querySelector('.ws-plan__msg').textContent = '';
      splitSet.querySelector('.ws-pages__msg').textContent = '';
      splitSet.querySelector('.ws-split__total').textContent = '';
      orderEl.textContent = '';
      mergeSet.querySelector('.ws-merge__sum').textContent = '';
      mergeSet.querySelector('.ws-merge__msg').textContent = '';
      setMsg.textContent = '';
    }

    function renderSettings() {
      const item = selected();
      const merging = !!merge;
      const tab = merging ? null : pdfTab(item);
      setEl.classList.toggle('is-empty', !item && !merging);
      setEl.classList.toggle('is-merge', merging);
      tabsEl.hidden = !tab;
      imgSet.hidden = merging || !item || item.kind !== 'image';
      pdfSet.hidden = tab !== 'compress';
      splitSet.hidden = tab !== 'split';
      docSet.hidden = merging || !item || item.kind !== 'doc';
      mergeSet.hidden = !merging;
      if (tab !== 'split') grid.reset();
      $('.ws-set__file').textContent = merging ? tx('ws.261', { n: merge.order.length }) : item ? item.file.name : '';
      $('.ws-set__kind').textContent = merging ? tx('ws.226') : item ? KINDS[item.kind].label : '';
      if (merging) { renderMerge(); return; }
      if (!item) { clearSettingsLeftovers(); return; }
      tabsEl.querySelectorAll('[data-tab]').forEach((b) => {
        const on = b.dataset.tab === tab;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      if (item.kind === 'image') fillImage(item.settings);
      else if (item.kind === 'doc') fillDoc(item.settings);
      else if (tab === 'split') fillSplit(item);
      else fillPdf(item.settings);
      renderActions(item);
    }

    function renderActions(item) {
      if (pdfTab(item) === 'split') { renderSplitActions(item); return; }
      revertBtn.querySelector('span').textContent = tx('ws.175');
      const chk = checkSettings(item.kind, item.settings);
      const dirty = isDirty(item);
      const busy = item.status === 'queued' || item.status === 'working';
      let label = tx('ws.083');
      let disabled = !!(chk && chk.block);
      if (item.probing) { label = tx('ws.084'); disabled = true; }
      else if (item.info.secure) { label = tx('ws.085'); disabled = true; }
      else if (item.applied && (dirty || item.status === 'error')) label = tx('ws.086');
      else if (busy) { label = tx('ws.087'); disabled = true; }
      else if (item.status === 'done') { label = tx('ws.088'); disabled = true; }
      applyBtn.querySelector('span').textContent = label;
      applyBtn.disabled = disabled;
      revertBtn.disabled = !item.applied;
      setMsg.textContent = dirty
        ? (busy ? tx('ws.089') : tx('ws.090'))
        : '';
      const same = state.items.filter((it) => it.kind === item.kind && !it.info.secure);   // 처리 못 하는 보안 문서는 빼고 셈
      applyAllBtn.hidden = same.length < 2;
      applyAllBtn.querySelector('span').textContent = tx('ws.091', { p: KINDS[item.kind].label, sameCount: same.length });
      applyAllBtn.disabled = !!(chk && chk.block);
    }
    /** 나누기 탭의 버튼: [나누기] / [다시 나누기] · [나눈 파일 지우기]. 같은 종류 전체 적용은 없음 */
    function renderSplitActions(item) {
      const sp = item.split;
      const chk = splitCheck(item);
      const dirty = isSplitDirty(item);
      const busy = sp.status === 'queued' || sp.status === 'working';
      let label = tx('ws.191');
      let disabled = !!(chk && chk.block);
      if (sp.applied && (dirty || sp.status === 'error')) label = tx('ws.193');
      else if (busy) { label = tx('ws.087'); disabled = true; }
      else if (sp.status === 'done') { label = tx('ws.088'); disabled = true; }
      applyBtn.querySelector('span').textContent = label;
      applyBtn.disabled = disabled;
      revertBtn.querySelector('span').textContent = tx('ws.202');
      revertBtn.disabled = !sp.applied;
      setMsg.textContent = dirty ? (busy ? tx('ws.089') : tx('ws.218')) : '';
      applyAllBtn.hidden = true;
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
        // PDF 는 압축 모드만 옮긴다 (탭·나누기 설정은 파일마다 다름)
        it.settings = it.kind === 'pdf' ? { ...it.settings, mode: cur.settings.mode } : { ...cur.settings };
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
      setMsg.textContent = n ? tx('ws.092', { n }) : tx('ws.093');
    });

    /* ===================== 합치기 ===================== */
    const pickbar = $('.ws-pickbar');
    const orderEl = mergeSet.querySelector('.ws-order');
    const mergeName = mergeSet.querySelector('#ws-merge-name');
    const nameBtn = mergeSet.querySelector('[data-act="merge-name"]');
    const mergeRun = mergeSet.querySelector('[data-act="merge-run"]');
    const pickedItems = () => state.items.filter((it) => picked.has(it.id) && mergeable(it));
    /** 체크했지만 합칠 수 없는 것: 문서 · 암호 PDF (형식 확인 중인 것은 아직 모르므로 빼고 셈) */
    const pickedOut = () => state.items.filter((it) => picked.has(it.id) && !it.probing && !mergeable(it));
    const mergeItems = () => (merge ? merge.order.map((id) => state.items.find((it) => it.id === id)).filter(Boolean) : []);
    const mergeBusy = () => !!merge && (merge.status === 'queued' || merge.status === 'working');
    /** 합칠 때 쓰는 파일: 처리 결과가 있으면 결과(예: JPG 로 바꾼 HEIC), 없으면 원본 */
    const usesResult = (it) => it.status === 'done' && !!it.result && !isKept(it) && !!it.blob;
    const mergeBlob = (it) => (usesResult(it) ? it.blob : it.file);
    const ymd = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
    const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\.pdf$/i, '').trim();
    /** 이름을 가운데에서 줄이도록 [앞부분][확장자] 두 칸에 나눠 넣는다 */
    const fillMid = (el, name) => {
      const dot = name.lastIndexOf('.');
      el.querySelector('.ws-mid__a').textContent = dot > 0 ? name.slice(0, dot) : name;
      el.querySelector('.ws-mid__b').textContent = dot > 0 ? name.slice(dot) : '';
    };

    /** 목록 위 [N개 합치기] + 체크했지만 합칠 수 없는 것 안내 */
    function renderPickbar() {
      const n = pickedItems().length;
      const out = pickedOut();
      pickbar.hidden = state.items.length < 2 && !picked.size;
      const btn = pickbar.querySelector('[data-act="merge"]');
      btn.querySelector('span').textContent = n >= 2 ? tx('ws.227', { n }) : tx('ws.226');
      btn.disabled = n < 2 || mergeBusy();
      pickbar.querySelector('[data-act="unpick"]').hidden = picked.size === 0;
      pickbar.querySelector('.ws-pickbar__hint').hidden = n >= 2 || out.length > 0;
      const lines = [];
      if (out.some((it) => it.kind === 'doc')) lines.push(tx('ws.276'));
      const locked = out.filter((it) => it.kind === 'pdf');
      if (locked.length) lines.push(tx('ws.277', { name: locked.map((it) => it.file.name).join(', ') }));
      const warn = pickbar.querySelector('.ws-pickbar__warn');
      warn.textContent = lines.join(' ');
      warn.hidden = !lines.length;
    }
    pickbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'unpick') {
        picked.clear();
        if (merge && !mergeBusy()) merge = null;
        state.items.forEach(renderRow);
        renderPickbar();
        renderSettings();
      }
      if (b.dataset.act === 'merge') openMerge();
    });

    function openMerge() {
      const items = pickedItems();
      if (items.length < 2) return;
      if (!merge || !mergeBusy()) {
        merge = {
          order: items.map((it) => it.id), size: 'a4', orient: 'auto', margin: 'narrow',
          name: tx('ws.244', { ymd: ymd() }), editing: false,
          job: null, status: 'idle', pct: 0, stage: '', error: '', runIds: [],
        };
      }
      renderSettings();
      if (isNarrow()) $('.ws-settings').scrollIntoView({ behavior: smooth(), block: 'start' });
      const first = orderEl.querySelector('li');
      if (first) first.focus({ preventScroll: isNarrow() });
    }
    /** 체크를 더하거나 빼면 순서 목록도 맞춘다 (이미 정한 순서는 그대로, 새로 고른 것은 끝에) */
    function syncMergeOrder() {
      if (!merge) return;
      const ok = new Set(pickedItems().map((it) => it.id));
      merge.order = merge.order.filter((id) => ok.has(id));
      for (const it of pickedItems()) if (!merge.order.includes(it.id)) merge.order.push(it.id);
    }

    /** 합치기 확인 (예상 용량이 PDF 한도·목록 용량 합을 넘거나 목록이 차면 시작 전에 막고 안내) */
    function mergeCheck(items, est) {
      const lim = currentLimits();
      if (items.length < 2) return { text: tx('ws.250'), block: true };
      if (!safeName(merge.name)) return { text: tx('ws.255'), block: true };
      if (est > lim.maxPdfFile) return { text: tx('ws.247', { p: mbText(est), max: mbText(lim.maxPdfFile) }), block: true };
      const sum = state.items.reduce((n, it) => n + it.file.size, 0);
      if (sum + est > lim.total) return { text: tx('ws.248', { p: mbText(est), max: mbText(lim.total) }), block: true };
      if (state.items.length + 1 > lim.count) return { text: tx('ws.249', { count: lim.count }), block: true };
      return null;
    }

    /* 정렬: 이름순(숫자는 숫자 크기대로) · 올린 순(목록에 들어온 차례) */
    const SORTS = {
      name: (a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id - b.id,
      added: (a, b) => a.id - b.id,
    };
    const sortedIds = (k) => [...mergeItems()].sort(SORTS[k]).map((it) => it.id);

    function renderMerge() {
      if (!merge) return;
      const items = mergeItems();
      // 다시 그려도 포커스는 같은 줄(같은 버튼)에 남긴다
      const fa = document.activeElement;
      const keep = fa && orderEl.contains(fa) && fa.closest('li')
        ? { id: Number(fa.closest('li').dataset.id), act: fa.dataset.act || '' } : null;
      orderEl.textContent = '';
      let pages = 0, unknown = false, est = 0;
      items.forEach((it, i) => {
        const p = it.kind === 'pdf' ? it.info.pages : 1;
        if (p) pages += p; else unknown = true;
        const blob = mergeBlob(it);
        const rType = usesResult(it) && it.result.ext ? ({ jpg: 'jpeg' })[it.result.ext] || it.result.ext : it.info.type;
        est += mergeEstimate({ kind: it.kind, size: blob.size, type: rType, width: (it.result && it.result.width) || it.info.width, height: (it.result && it.result.height) || it.info.height });
        const li = document.createElement('li');
        li.className = 'ws-order__item';
        li.tabIndex = 0;
        li.dataset.id = it.id;
        li.title = it.file.name;
        li.setAttribute('aria-describedby', 'ws-merge-hint');
        const last = i === items.length - 1;
        li.innerHTML = `
          <span class="ws-order__grip" data-grip aria-hidden="true">${icon('grip', 16)}</span>
          <span class="ws-order__no" aria-hidden="true"></span>
          <span class="ws-order__thumb"><img alt="" decoding="async" draggable="false"><span class="ws-item__ph">${icon(KINDS[it.kind].icon, 16)}</span></span>
          <span class="ws-order__body"><span class="ws-order__name ws-mid"><span class="ws-mid__a"></span><span class="ws-mid__b"></span></span><span class="ws-order__meta"></span></span>
          <span class="ws-order__btns">
            <button type="button" class="ws-order__btn" data-act="up" title="${tx('ws.285')}" ${i === 0 ? 'disabled' : ''}>${icon('up', 16)}<span class="sr-only">${tx('ws.285')}</span></button>
            <button type="button" class="ws-order__btn" data-act="down" title="${tx('ws.286')}" ${last ? 'disabled' : ''}>${icon('down', 16)}<span class="sr-only">${tx('ws.286')}</span></button>
            <button type="button" class="ws-order__btn" data-act="drop" title="${tx('ws.235')}">${icon('close', 16)}<span class="sr-only">${tx('ws.235')}</span></button>
          </span>`;
        li.querySelector('.ws-order__no').textContent = i + 1;
        if (it.thumbUrl) li.querySelector('img').src = it.thumbUrl;
        fillMid(li.querySelector('.ws-order__name'), it.file.name);
        const meta = [p ? tx('ws.062', { pages: p }) : tx('ws.257')];
        if (usesResult(it)) meta.push(tx('ws.113'));   // 처리 결과(예: JPG 로 바꾼 사진)를 넣는다
        li.querySelector('.ws-order__meta').textContent = meta.join(' · ');
        li.setAttribute('aria-label', `${i + 1}. ${it.file.name}, ${meta.join(', ')}`);
        orderEl.append(li);
      });
      if (keep) {
        const li = orderEl.querySelector(`li[data-id="${keep.id}"]`);
        const btn = li && keep.act ? li.querySelector(`[data-act="${keep.act}"]`) : null;
        (btn && !btn.disabled ? btn : li || orderEl.querySelector('li') || nameBtn).focus();
      }
      merge.est = est;
      // 정렬 버튼: 지금 순서가 그 정렬과 같으면 눌린 모양
      mergeSet.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(sortedIds(b.dataset.sort).join() === merge.order.join())));
      // 사진 설정은 사진이 하나라도 있을 때만
      mergeSet.querySelector('.ws-merge__photo').hidden = !items.some((it) => it.kind === 'image');
      mergeSet.querySelectorAll('input[name="ws-msize"]').forEach((r) => { r.checked = r.value === merge.size; });
      mergeSet.querySelectorAll('input[name="ws-morient"]').forEach((r) => { r.checked = r.value === merge.orient; });
      mergeSet.querySelectorAll('input[name="ws-margin"]').forEach((r) => { r.checked = r.value === merge.margin; });
      const fit = merge.size === 'fit';
      mergeSet.querySelector('.ws-merge__orient').disabled = fit;
      mergeSet.querySelector('.ws-merge__orienthint').textContent = fit ? tx('ws.299') : '';
      // 만들어질 파일: 이름(눌러서 바꾸기) · 총 N쪽 · 예상 용량
      const nameRow = mergeSet.querySelector('.ws-merge__name');
      nameRow.hidden = !merge.editing;
      nameBtn.hidden = merge.editing;
      fillMid(nameBtn, `${merge.name}.pdf`);
      nameBtn.setAttribute('aria-label', tx('ws.290', { name: `${merge.name}.pdf` }));
      if (document.activeElement !== mergeName) mergeName.value = merge.name;
      mergeSet.querySelector('.ws-merge__sum').textContent = tx('ws.237', { pages: unknown ? `${pages}+` : pages, p: formatBytes(est) });
      $('.ws-set__file').textContent = tx('ws.261', { n: items.length });
      renderMergeProgress();
    }
    function renderMergeProgress() {
      const busy = mergeBusy();
      const chk = mergeCheck(mergeItems(), merge.est || 0);
      const bar = mergeSet.querySelector('.ws-progress');
      bar.hidden = !busy;
      bar.firstElementChild.style.width = gauge(merge.pct);
      mergeRun.disabled = busy || !!(chk && chk.block);
      mergeRun.querySelector('span').textContent = busy ? tx('ws.087') : tx('ws.245');
      const msg = mergeSet.querySelector('.ws-merge__msg');
      msg.textContent = busy ? `${merge.stage || tx('ws.049')} · ${Math.round(merge.pct * 100)}%`
        : merge.status === 'error' ? merge.error : chk ? chk.text : '';
      msg.classList.toggle('is-busy', busy);
      renderPickbar();
    }

    /** 순서 옮기기 (끌기·↑↓ 키·↑↓ 버튼 공통). act = 옮긴 뒤 포커스를 둘 버튼 */
    function moveOrder(from, to, act = '') {
      if (!merge || to < 0 || to >= merge.order.length || from === to) return;
      const [id] = merge.order.splice(from, 1);
      merge.order.splice(to, 0, id);
      renderMerge();
      const li = orderEl.querySelector(`li[data-id="${id}"]`);
      const btn = li && act ? li.querySelector(`[data-act="${act}"]`) : null;
      if (li) (btn && !btn.disabled ? btn : li).focus();
      mergeSet.querySelector('.ws-merge__live').textContent = tx('ws.236', { n: to + 1 });
    }
    sortable(orderEl, { onMove: (from, to) => moveOrder(from, to) });
    orderEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !merge || b.disabled) return;
      const id = Number(b.closest('li').dataset.id);
      const i = merge.order.indexOf(id);
      if (b.dataset.act === 'up') { moveOrder(i, i - 1, 'up'); return; }
      if (b.dataset.act === 'down') { moveOrder(i, i + 1, 'down'); return; }
      if (b.dataset.act !== 'drop') return;
      picked.delete(id);
      syncMergeOrder();
      const it = state.items.find((x) => x.id === id);
      if (it) renderRow(it);
      renderMerge();
      const next = orderEl.children[Math.min(i, orderEl.children.length - 1)];
      (next || nameBtn).focus();
    });
    mergeSet.addEventListener('click', (e) => {
      const s = e.target.closest('[data-sort]');
      if (!s || !merge) return;
      merge.order = sortedIds(s.dataset.sort);
      renderMerge();
      mergeSet.querySelector('.ws-merge__live').textContent = tx('ws.300', { p: s.textContent.trim() });
    });
    mergeSet.addEventListener('change', (e) => {
      if (!merge) return;
      if (e.target.name === 'ws-msize') merge.size = e.target.value;
      else if (e.target.name === 'ws-morient') merge.orient = e.target.value;
      else if (e.target.name === 'ws-margin') merge.margin = e.target.value;
      else return;
      renderMerge();
    });

    /* 결과 이름: 눌러서 바꾸기 (Enter·칸 밖 = 확정, Esc = 취소) */
    nameBtn.addEventListener('click', () => {
      if (!merge) return;
      merge.editing = true;
      merge.nameBefore = merge.name;
      renderMerge();
      mergeName.focus();
      mergeName.select();
    });
    const commitName = (cancel = false) => {
      if (!merge || !merge.editing) return;
      merge.name = cancel ? merge.nameBefore : safeName(mergeName.value) || merge.nameBefore;
      merge.editing = false;
      renderMerge();
    };
    mergeName.addEventListener('input', () => { if (merge) { merge.name = mergeName.value; renderMergeProgress(); } });
    mergeName.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      commitName(e.key === 'Escape');
      nameBtn.focus();
    });
    mergeName.addEventListener('blur', () => commitName());

    mergeRun.addEventListener('click', () => {
      if (!merge) return;
      const items = mergeItems();
      const chk = mergeCheck(items, merge.est || 0);
      if (chk && chk.block) return;
      merge.name = safeName(merge.name);
      merge.job = ++jobSeq;
      merge.runIds = items.map((it) => it.id);
      jobs.set(merge.job, { item: null, track: 'merge' });
      Object.assign(merge, { status: 'queued', pct: 0, stage: tx('ws.049'), error: '' });
      const sources = items.map((it) => ({ file: mergeBlob(it), kind: it.kind, name: it.file.name }));
      pool.add({ id: merge.job, file: null, options: { engine: 'merge', sources, size: merge.size, orient: merge.orient, margin: merge.margin } });
      renderMergeProgress();
    });
    mergeSet.querySelector('[data-act="merge-cancel"]').addEventListener('click', () => {
      if (!merge) return;
      if (merge.job != null) { pool.abort(merge.job); jobs.delete(merge.job); }
      merge = null;
      renderSettings();
      renderPickbar();
      const it = selected();
      (it ? it.el.querySelector('.ws-item__main') : drop).focus();
    });

    function onMergeMessage(msg) {
      if (!merge || merge.job !== msg.id) return;
      if (msg.type === 'thumb') return;
      if (msg.type === 'progress') {
        Object.assign(merge, { status: 'working', pct: msg.pct, stage: msg.stage });
        renderMergeProgress();
        return;
      }
      jobs.delete(msg.id);
      merge.job = null;
      if (msg.type !== 'done') {
        Object.assign(merge, { status: 'error', error: msg.message || tx('ws.050') });
        renderMergeProgress();
        return;
      }
      const r = msg.result;
      // 워커가 열어 보고서야 안 암호 PDF: 빼고 합쳤다 → 그 항목에 표시하고 결과 화면에서 안내
      const skipped = (r.skipped || []).map((i) => state.items.find((x) => x.id === merge.runIds[i])).filter(Boolean);
      skipped.forEach((it) => { it.info.encrypted = true; });
      const file = new File([r.bytes], `${merge.name || tx('ws.244', { ymd: ymd() })}.pdf`, { type: 'application/pdf' });
      const item = addMade(file, {
        by: 'merge', counts: r.counts.filter((c) => c > 0), lost: r.lost, skipped: skipped.map((it) => it.file.name),
      }, { pages: r.pages });
      picked.clear();
      merge = null;
      // 원본 파일들은 목록에 그대로. 합친 PDF 를 골라 두고, 결과 화면의 [이어서 압축하기]로 바로 이어 간다
      item.settings.tab = 'compress';
      select(item.id);
      renderAll();
      item.el.scrollIntoView({ block: 'nearest', behavior: smooth() });
      const next = $('[data-act="next-compress"]');
      if (next && !next.closest('[hidden]')) next.focus({ preventScroll: !isNarrow() });
    }

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
    // [이어서 압축하기]: 그 PDF 의 [압축] 탭으로 바로 이동
    $('[data-act="next-compress"]').addEventListener('click', () => {
      const item = selected();
      if (!item) return;
      item.settings.tab = 'compress';
      renderSettings();
      renderView();
      if (isNarrow()) $('.ws-settings').scrollIntoView({ behavior: smooth(), block: 'start' });
      applyBtn.focus({ preventScroll: !isNarrow() });
    });
    viewDl.addEventListener('click', (e) => {
      if (!viewDl.getAttribute('href')) { e.preventDefault(); return; }
      markExported(state.selectedId);
    });

    function renderProgress(item) {
      const t = pdfTab(item) === 'split' ? item.split : item;   // 나누기 탭이면 나누기 진행
      const busy = t.status === 'queued' || t.status === 'working';
      const bar = statusBox.querySelector('.ws-progress');
      bar.hidden = !busy;
      bar.firstElementChild.style.width = gauge(t.pct);
      const text = statusBox.querySelector('.ws-view__msg');
      if (t.status === 'queued') text.textContent = tx('ws.094');
      else if (t.status === 'working') text.textContent = `${t.stage} · ${Math.round(t.pct * 100)}%`;
    }
    /** 나눈 파일 쪽 수 요약 "3쪽·1쪽·3쪽" (모두 같으면 "각 1쪽", 많으면 앞 6개 …) */
    function countsText(counts) {
      if (counts.length > 1 && counts.every((c) => c === counts[0])) return tx('ws.262', { pages: counts[0] });
      const shown = counts.slice(0, 6).map((c) => tx('ws.062', { pages: c })).join('·');
      return counts.length > 6 ? `${shown}…` : shown;
    }
    /** 나누기·합치기 결과에 작게 붙이는 안내 */
    function setFine(on) {
      const fine = $('.ws-view__fine');
      fine.textContent = on ? tx('ws.221') : '';
      fine.hidden = !on;
    }

    /** 나누기 탭의 결과 화면: 원본 첫 쪽 + "원본 12쪽 → 3개 파일(3쪽·1쪽·3쪽)" */
    async function renderSplitView(item, seq) {
      const sp = item.split;
      const r = sp.result;
      const ready = sp.status === 'done' && r;
      statusBox.dataset.tone = sp.status === 'error' ? (sp.notice ? 'warn' : 'danger') : ready ? 'good' : 'muted';
      const msg = statusBox.querySelector('.ws-view__msg');
      if (sp.status === 'idle') msg.textContent = tx('ws.225');
      else if (sp.status === 'error') msg.textContent = sp.stage;
      else if (ready) msg.textContent = tx('ws.219', { total: r.pages, n: r.partIds.length, list: countsText(r.counts) });
      renderProgress(item);
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
      const total = (r && r.pages) || item.info.pages;
      row(tx('ws.110'), total ? tx('ws.062', { pages: total }) : '—', r ? tx('ws.224', { n: r.partIds.length }) : '');
      row(tx('ws.112'), formatBytes(workBlob(item).size), r ? formatBytes(r.size) : '');
      $('.ws-view__pctline').hidden = true;
      const note = $('.ws-view__note');
      note.textContent = ready && workBlob(item) !== item.file ? tx('ws.263') : '';
      note.hidden = !note.textContent;
      setFine(!!ready);
      viewDl.removeAttribute('href');
      viewDl.hidden = true;
      cmp.classList.add('is-pending');
      $('.ws-cmp__caption').textContent = tx('ws.100');
      setSplit(50);
      cmp.classList.add('is-loading');
      const before = await getPreview(item, 'before');
      if (seq !== viewSeq) return;
      cmp.classList.remove('is-loading');
      cmp.classList.toggle('is-noimg', !before);
      if (before) { beforeImg.src = before.url; afterImg.src = before.url; } else { beforeImg.removeAttribute('src'); afterImg.removeAttribute('src'); }
      $('.ws-cmp__noimg').textContent = item.info.previewFailed ? tx('ws.102') : tx('ws.103');
      zoomWidth = (before && before.width) || 0;
      applyZoom();
    }

    let viewSeq = 0;
    /**
     * 결과 칸 처음 상태: 앞 파일의 그림(이미 해제한 blob 주소)·표·안내·받기 링크를 비우고,
     * 그 파일 미리보기를 그리던 중이었으면 끝나도 그리지 않게 한다(viewSeq).
     */
    function clearViewLeftovers() {
      viewSeq++;
      beforeImg.removeAttribute('src');
      afterImg.removeAttribute('src');
      zoomWidth = 0;
      applyZoom();
      cmp.classList.remove('is-loading', 'is-noimg');
      $('.ws-cmp__caption').textContent = '';
      $('.ws-stats tbody').textContent = '';
      statusBox.querySelector('.ws-view__msg').textContent = '';
      statusBox.querySelector('.ws-progress').hidden = true;
      $('.ws-view__pctline').hidden = true;
      $('.ws-view__note').hidden = true;
      $('.ws-view__next').hidden = true;
      setFine(false);
      viewDl.removeAttribute('href');
      viewDl.hidden = true;
    }

    async function renderView() {
      const item = selected();
      view.classList.toggle('is-empty', !item);
      $('.ws-view__body').hidden = !item;
      $('.ws-view__file').textContent = item ? item.file.name : '';
      if (!item) { clearViewLeftovers(); return; }
      const seq = ++viewSeq;
      $('.ws-view__next').hidden = true;
      if (pdfTab(item) === 'split') { renderSplitView(item, seq); return; }
      const r = item.result;
      const ready = item.status === 'done' && r;
      const changed = ready && r.kind !== 'original';

      // 상태 안내 (나누기·합치기로 만든 파일은 그렇게 만들었다고 먼저 알린다)
      statusBox.dataset.tone = item.status === 'error' ? (item.notice ? 'warn' : 'danger') : ready || item.made ? 'good' : 'muted';
      const msg = statusBox.querySelector('.ws-view__msg');
      if (item.status === 'idle') msg.textContent = item.made
        ? (item.made.by === 'merge' ? tx('ws.223', { n: item.made.counts.length, pages: item.info.pages }) : tx('ws.222', { from: item.made.fromName }))
        : item.kind === 'doc'
          ? tx('ws.095')
          : tx('ws.096');
      else if (item.status === 'error') msg.textContent = item.stage;
      else if (ready) msg.textContent = r.kind === 'original' ? r.note || tx('ws.097')
        : item.kind === 'doc' ? tx('ws.098')
        : tx('ws.099');
      renderProgress(item);

      renderStats(item);
      setFine(!!item.made);
      // 합친 PDF (아직 압축 전): [이어서 압축하기] — 크면 '제출용이라면 압축을 추천해요'
      const merged = !!(item.made && item.made.by === 'merge');
      const next = $('.ws-view__next');
      next.hidden = !(merged && item.status === 'idle');
      $('.ws-view__nexthint').textContent = item.file.size > NEXT_HINT_BYTES ? tx('ws.298') : '';
      if (merged && item.status === 'idle' && item.made.skipped && item.made.skipped.length) {
        const note = $('.ws-view__note');
        note.textContent = tx('ws.278', { names: item.made.skipped.join(', ') });
        note.hidden = false;
      }

      // 다운로드 (만든 PDF 는 처리 전에도 그대로 받을 수 있다)
      const prod = productOf(item);
      if (ready || prod) {
        viewDl.href = prod ? prod.url() : origUrlOf(item);
        viewDl.download = prod ? prod.name : item.file.name;
        viewDl.removeAttribute('aria-disabled');
        viewDl.hidden = false;
      } else {
        viewDl.removeAttribute('href');
        viewDl.hidden = true;
      }

      // 그림
      cmp.classList.toggle('is-pending', !changed);
      $('.ws-cmp__caption').textContent = item.kind === 'pdf' ? tx('ws.100')
        : item.kind === 'doc' && r && r.compare ? tx('ws.101', { name: r.compare.name, p: formatBytes(r.compare.beforeSize), p1: formatBytes(r.compare.afterSize) }) : '';
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
        ? (item.info.previewFailed ? tx('ws.102') : tx('ws.103'))
        : item.kind === 'doc'
          ? (ready ? tx('ws.104') : tx('ws.105'))
          : tx('ws.106');
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
        row(tx('ws.107'), ow ? `${ow}×${oh}` : '—', r && r.width ? `${r.width}×${r.height}` : ow ? `${ow}×${oh}` : '—');
      } else if (item.kind === 'doc') {
        const n = item.info.images;
        row(tx('ws.001'), n !== undefined ? tx('ws.108', { n }) : '—', r && r.images ? tx('ws.109', { compressed: r.images.compressed }) : '—');
      } else {
        const pages = (r && r.pages) || item.info.pages;
        row(tx('ws.110'), pages ? tx('ws.062', { pages }) : '—', pages ? tx('ws.062', { pages }) : '—');
      }
      row(tx('ws.111'), srcLabel(item), r ? RESULT_LABEL[r.ext] || r.ext.toUpperCase() : '');
      row(tx('ws.112'), formatBytes(item.file.size), r ? formatBytes(r.size) : '');

      const pct = $('.ws-view__pct');
      pct.textContent = ready ? (r.kind === 'original' ? tx('ws.024') : changeText(item.file.size, r.size)) : '';
      pct.className = `ws-badge ws-view__pct ws-badge--${ready && r.warn ? 'warn' : ready && r.size < item.file.size ? 'good' : 'muted'}`;
      $('.ws-view__pctline').hidden = !ready;
      $('.ws-view__pctlabel').textContent = ready && r.kind === 'original' ? tx('ws.113') : ready && r.size > item.file.size ? tx('ws.114') : tx('ws.115');

      const bits = [];
      if (ready) {
        if (r.targetBytes) bits.push(r.size <= r.targetBytes ? tx('ws.116', { p: targetLabel(r.targetBytes) }) : tx('ws.117', { p: targetLabel(r.targetBytes) }));
        if (r.kind === 'lossy' && item.kind === 'image' && r.ssim) bits.push(tx('ws.118', { p: (r.ssim * 100).toFixed(1) }));
        if (r.note && r.kind !== 'original') bits.push(r.note);
        if (r.firstFrame) bits.push(item.info.type === 'gif' ? tx('ws.119') : tx('ws.120'));
        if (r.filled) {
          bits.push(r.filled.toLowerCase() === DEFAULTS.image.bg
            ? tx('ws.121')
            : tx('ws.122', { filled: r.filled }));
        }
        if (r.grew) bits.push(tx('ws.123'));
        if (r.warn) bits.push(r.warn);
        if (item.kind === 'doc') bits.push(tx('ws.124'), tx('ws.125'));
      }
      const note = $('.ws-view__note');
      note.textContent = bits.join(' · ');
      note.hidden = !bits.length;
    }

    /* ===================== 요약 · 내보내기 ===================== */
    const doneItems = () => state.items.filter((it) => it.status === 'done' && it.result);
    // 내보낼 것 = 원본 유지가 아닌 처리 결과 + 나누기·합치기로 만든 파일 (원본 유지는 ZIP 에서 기본으로 뺀다)
    const exportItems = () => state.items.filter((it) => productOf(it));
    const keptItems = () => doneItems().filter((it) => isKept(it) && !it.made);
    const unsaved = (it) => !!productOf(it) && !it.exported;
    const unsavedCount = () => state.items.filter(unsaved).length;

    function renderSummary() {
      renderFilter();
      const total = state.items.length;
      const exportable = exportItems();
      const kept = keptItems();
      $('.ws-list__empty').hidden = total > 0;
      drop.classList.toggle('is-compact', total > 0);
      // 원본 유지 개수는 내보내기 버튼 아래 안내에 (여기 붙이면 좁은 패널에서 제목이 두 줄로 밀림)
      $('.ws-list__count').textContent = total ? tx('ws.126', { total, exportableCount: exportable.length }) : '';
      const exp = $('[data-act="export"]');
      exp.disabled = exportable.length === 0;
      exp.querySelector('span').textContent = exportable.length ? tx('ws.127', { exportableCount: exportable.length }) : tx('ws.128');
      const keptNote = $('.ws-export__kept');
      keptNote.textContent = kept.length ? tx('ws.129', { keptCount: kept.length }) : '';
      keptNote.hidden = !kept.length;
      $('[data-act="clear"]').hidden = total === 0;
      // 합계는 실제로 줄어든 파일만 (원본 유지·형식 변환으로 커진 파일은 빼고)
      const sum = $('.ws-list__sum');
      const shrunk = exportable.filter((it) => it.status === 'done' && it.result && !isKept(it) && it.result.size < it.file.size);
      if (shrunk.length) {
        const orig = shrunk.reduce((n, it) => n + it.file.size, 0);
        const out = shrunk.reduce((n, it) => n + it.result.size, 0);
        const left = unsavedCount();
        sum.textContent = tx('ws.130', { shrunkCount: shrunk.length, p: formatBytes(orig), p1: formatBytes(out), p2: changeText(orig, out) }) + (left ? tx('ws.131', { left }) : '');
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
      renderPickbar();
    }

    $('[data-act="export"]').addEventListener('click', exportZip);
    async function exportZip() {
      const btn = $('[data-act="export"]');
      const done = exportItems();   // 원본 유지 파일은 빼고
      if (!done.length) return;
      btn.disabled = true;
      const label = btn.querySelector('span');
      label.textContent = tx('ws.132');
      try {
        const { zipSync } = await import(FFLATE_URL);
        const files = {};
        const used = new Set();
        for (const it of done) {
          const prod = productOf(it);
          let name = prod.name;
          if (used.has(name.toLowerCase())) {
            const dot = name.lastIndexOf('.');
            let n = 2;
            while (used.has(`${name.slice(0, dot)} (${n})${name.slice(dot)}`.toLowerCase())) n++;
            name = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
          }
          used.add(name.toLowerCase());
          // 이미 압축된 파일이라 ZIP 압축은 생략(level 0) — 빠르고 크기 차이 없음
          files[name] = [new Uint8Array(await prod.blob.arrayBuffer()), { level: 0 }];
        }
        const zip = zipSync(files);
        const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
        const a = document.createElement('a');
        a.href = url;
        // 이용자 기기의 오늘 날짜 (toISOString 은 UTC 라 한국 시간 오전 9시 전엔 하루 전 날짜가 됨)
        const d = new Date();
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        a.download = `slimkachi_${ymd}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        done.forEach((it) => { it.exported = true; });
      } catch (err) {
        console.error(err);
        alert(tx('ws.133'));
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
      grid.reset();
      listIO.disconnect();
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
      <h2 class="ws-title">${tx('ws.135')}</h2>
      <ol class="ws-steps" aria-label="${tx('ws.136')}">
        <li>${tx('ws.137')}</li><li>${tx('ws.138')}</li><li>${tx('ws.139')}</li><li>${tx('ws.140')}</li><li>${tx('ws.141')}</li>
      </ol>
    </header>

    <div class="ws-hero">
      <h2 class="ws-hero__title">${tx('ws.187')}</h2>
      <p class="ws-hero__lead">${tx('ws.188')}</p>
      <p class="ws-hero__note">${tx('ws.189')}</p>
    </div>

    <div class="ws-drop" tabindex="0" role="button" aria-label="${tx('ws.142')}">
      <div class="ws-drop__inner">
        <span class="ws-drop__icon">${icon('upload', 30)}</span>
        <strong>${tx('ws.143')}</strong>
        <span class="muted ws-drop__limit">${tx('ws.144', { count: lim.count, p: mbText(lim.total), p1: mpText(lim.maxPixels), p2: mbText(lim.maxPdfFile) })}</span>
      </div>
      <input id="ws-file" type="file" accept="${ACCEPT}" multiple hidden>
    </div>
    <!-- 업로드 칸(누르면 파일 선택) 밖에 둔다 — 안에 두면 펼칠 때 파일 창이 열림 -->
    <details class="ws-formats">
      <summary>${tx('ws.145')} <span aria-hidden="true">▾</span></summary>
      <dl class="ws-formats__list">
        <div><dt>${tx('ws.001')}</dt><dd>${tx('ws.146')} <span class="muted">${tx('ws.147')}</span></dd></div>
        <div><dt>${tx('ws.002')}</dt><dd>${tx('ws.fmtDoc')} <span class="muted">${tx('ws.148')}</span></dd></div>
        <div><dt>PDF</dt><dd>PDF <span class="muted">${tx('ws.149')}</span></dd></div>
      </dl>
    </details>
    <p class="ws-drop__msg" role="status" aria-live="polite"></p>

    <!-- 올리지 못한 파일 안내 (모달). Esc·Enter 로 닫힘, 포커스는 안에 머문다 -->
    <dialog class="card ws-modal" role="dialog" aria-modal="true" aria-labelledby="ws-modal-title" aria-describedby="ws-modal-lead">
      <h2 class="ws-modal__title" id="ws-modal-title">${icon('info', 18)}<span>${tx('ws.150')}</span></h2>
      <p class="ws-modal__lead" id="ws-modal-lead"></p>
      <ul class="ws-modal__list" aria-label="${tx('ws.151')}"></ul>
      <p class="ws-modal__fix"></p>
      <div class="ws-modal__actions">
        <button type="button" class="btn btn--primary" data-act="modal-ok">${icon('check', 16)}<span>${tx('ws.152')}</span></button>
      </div>
    </dialog>

    <div class="ws-grid">
      <!-- 왼쪽: 설정 -->
      <section class="ws-panel ws-settings" aria-labelledby="ws-set-title">
        <div class="ws-panel__head">
          <h3 id="ws-set-title">${icon('settings', 18)}<span>${tx('ws.153')}</span></h3>
          <span class="ws-tag ws-set__kind"></span>
        </div>
        <p class="ws-set__file"></p>
        <p class="ws-empty ws-set__empty">${tx('ws.154')}</p>

        <!-- PDF 를 고르면 설정 위에 탭 [압축] [나누기] -->
        <div class="ws-tabs" role="tablist" aria-label="${tx('ws.260')}" hidden>
          ${PDF_TABS.map((t) => `<button type="button" class="ws-tab" role="tab" data-tab="${t.id}" aria-selected="false" tabindex="-1">${t.label}</button>`).join('')}
        </div>

        <div class="ws-set" data-kind="image" hidden>
          <fieldset class="ws-field ws-mode">
            <legend>${tx('ws.155')}</legend>
            ${seg('ws-mode-image', IMAGE_MODES, 3)}
            <p class="ws-hint"></p>
          </fieldset>

          <fieldset class="ws-field">
            <legend>${tx('ws.156')}</legend>
            ${seg('ws-resize', RESIZES, 2)}
            <div class="ws-rpanel" data-panel="percent" role="group" aria-label="${tx('ws.157')}">
              <div class="ws-row">
                ${PERCENTS.map((v) => chip(`data-percent="${v}"`, `${v}%`)).join('')}
              </div>
              <div class="ws-row">
                <span class="ws-label">${tx('ws.158')}</span>
                <input id="ws-percent" class="input ws-num" type="number" min="1" max="100" step="1" inputmode="numeric" aria-label="${tx('ws.159')}">
                <span class="ws-unit">%</span>
              </div>
            </div>
            <div class="ws-rpanel" data-panel="pixels" role="group" aria-label="${tx('ws.020')}" hidden>
              <div class="ws-row">
                <input id="ws-width" class="input ws-num" type="number" min="1" step="1" inputmode="numeric" aria-label="${tx('ws.160')}" placeholder="${tx('ws.161')}">
                <span class="ws-unit" aria-hidden="true">×</span>
                <input id="ws-height" class="input ws-num" type="number" min="1" step="1" inputmode="numeric" aria-label="${tx('ws.162')}" placeholder="${tx('ws.163')}">
                <span class="ws-unit">px</span>
              </div>
              <label class="ws-check"><input id="ws-keep" type="checkbox"> ${tx('ws.164')}</label>
              <span class="ws-label">${tx('ws.165')}</span>
              <div class="ws-row">
                ${PRESETS.map((p) => chip(`data-preset="${p.px}"`, p.label)).join('')}
              </div>
            </div>
            <div class="ws-rpanel" data-panel="target" role="group" aria-label="${tx('ws.022')}" hidden>
              <div class="ws-row">
                ${TARGET_PRESETS.map((t) => chip(`data-kb="${t.kb}"`, tx('ws.134', { label: t.label }))).join('')}
              </div>
              <div class="ws-row">
                <input id="ws-target" class="input ws-num" type="number" min="0" step="any" inputmode="decimal" aria-label="${tx('ws.166')}">
                <select id="ws-target-unit" class="input" aria-label="${tx('ws.167')}">
                  <option value="KB">KB</option>
                  <option value="MB">MB</option>
                </select>
                <span class="ws-unit">${tx('ws.168')}</span>
              </div>
            </div>
            <p class="ws-hint ws-resize-hint"></p>
          </fieldset>

          <div class="ws-field field">
            <label for="ws-format">${tx('ws.169')}</label>
            <select id="ws-format" class="input" aria-describedby="ws-format-hint">
              ${FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}
            </select>
            <p class="ws-hint ws-format-hint" id="ws-format-hint"></p>
          </div>

          <div class="ws-field ws-bg" hidden>
            <label for="ws-bg">${tx('ws.170')}</label>
            <div class="ws-row">
              <input id="ws-bg" class="input ws-color" type="color">
              <span class="ws-hint">${tx('ws.171')}</span>
            </div>
          </div>
        </div>

        <div class="ws-set" data-kind="doc" hidden>
          <fieldset class="ws-field">
            <legend>${tx('ws.155')}</legend>
            ${seg('ws-mode-doc', DOC_MODES, 3)}
            <p class="ws-hint"></p>
          </fieldset>
          <p class="ws-hint ws-doc__count" role="status"></p>
          <p class="ws-note">${icon('info', 16)}<span>${tx('ws.172')}</span></p>
        </div>

        <div class="ws-set" data-kind="pdf" hidden>
          <fieldset class="ws-field">
            <legend>${tx('ws.173')}</legend>
            ${seg('ws-mode-pdf', PDF_MODES, 3)}
            <p class="ws-hint"></p>
          </fieldset>
          <p class="ws-note">${icon('info', 16)}<span>${tx('ws.174')}</span></p>
        </div>

        <!-- PDF 나누기 -->
        <div class="ws-set" data-kind="split" hidden>
          <fieldset class="ws-field">
            <legend>${tx('ws.203')}</legend>
            ${seg('ws-split', SPLIT_METHODS, 2)}
            ${SPLIT_METHODS.map(splitExample).join('')}
          </fieldset>
          <fieldset class="ws-field ws-split__pick">
            <legend><span class="ws-split__ptitle">${tx('ws.206')}</span> <span class="ws-split__total muted"></span></legend>
            <input id="ws-range-text" class="input" type="text" inputmode="text" autocomplete="off" spellcheck="false"
              aria-label="${tx('ws.206')}" aria-describedby="ws-split-plan">
            <div class="ws-row ws-split__every" hidden>
              <input id="ws-every" class="input ws-num" type="number" min="1" step="1" inputmode="numeric" aria-label="${tx('ws.204')}" aria-describedby="ws-split-plan">
              <span class="ws-unit">${tx('ws.205')}</span>
            </div>
            <div class="ws-row">
              ${chip('data-pages="all"', tx('ws.215'))}
              ${chip('data-pages="none"', tx('ws.233'))}
            </div>
            <div class="ws-pages" role="group" aria-label="${tx('ws.264')}"></div>
            <p class="ws-hint ws-pages__msg"></p>
          </fieldset>
          <!-- 결과 미리보기: 만들어질 파일 목록, 잘못된 입력이면 그 자리에 안내 -->
          <div class="ws-split__plan" id="ws-split-plan" role="status" aria-live="polite">
            <p class="ws-plan__head"></p>
            <ol class="ws-plan"></ol>
            <p class="ws-plan__msg"></p>
          </div>
          <p class="ws-note">${icon('info', 16)}<span>${tx('ws.217')}</span></p>
        </div>

        <!-- 합치기 (목록에서 2개 이상 고르고 [합치기]) -->
        <div class="ws-set" data-kind="merge" hidden>
          <!-- 그림 예시 (나누기와 같은 모양): [계약서.pdf 3쪽] + [사진 1장] + [사진 1장] → 파일 1개 (5쪽) -->
          <div class="ws-ex">
            <div class="ws-ex__fig" aria-hidden="true">
              <span class="ws-ex__grp" data-gc="1"><span class="ws-ex__pg ws-ex__pg--wide">${tx('ws.280')}</span></span>
              <span class="ws-ex__arrow">+</span>
              <span class="ws-ex__grp" data-gc="1"><span class="ws-ex__pg ws-ex__pg--wide">${tx('ws.281')}</span></span>
              <span class="ws-ex__arrow">+</span>
              <span class="ws-ex__grp" data-gc="1"><span class="ws-ex__pg ws-ex__pg--wide">${tx('ws.281')}</span></span>
              <span class="ws-ex__arrow">→</span>
              <span class="ws-ex__n">${tx('ws.282')}</span>
            </div>
            <p class="ws-hint">${tx('ws.283')}</p>
          </div>
          <fieldset class="ws-field">
            <legend>${tx('ws.231')}</legend>
            <div class="ws-row">
              ${chip('data-sort="name"', tx('ws.279'))}
              ${chip('data-sort="added"', tx('ws.284'))}
            </div>
            <p class="ws-hint" id="ws-merge-hint">${tx('ws.232')}</p>
            <ol class="ws-order" aria-label="${tx('ws.231')}"></ol>
          </fieldset>
          <!-- 사진 설정: 사진이 하나라도 있을 때만 -->
          <fieldset class="ws-field ws-merge__photo" hidden>
            <legend>${tx('ws.238')}</legend>
            <fieldset class="ws-field ws-sub">
              <legend>${tx('ws.287')}</legend>
              ${seg('ws-msize', SIZE_OPTS, 2)}
            </fieldset>
            <fieldset class="ws-field ws-sub ws-merge__orient">
              <legend>${tx('ws.291')}</legend>
              ${seg('ws-morient', ORIENT_OPTS, 3)}
              <p class="ws-hint ws-merge__orienthint"></p>
            </fieldset>
            <fieldset class="ws-field ws-sub">
              <legend>${tx('ws.295')}</legend>
              ${seg('ws-margin', MARGIN_OPTS, 3)}
            </fieldset>
            <p class="ws-hint">${tx('ws.242')}</p>
          </fieldset>
          <!-- 만들어질 파일: 이름(눌러서 바꾸기) · 총 N쪽 · 예상 용량 -->
          <div class="ws-split__plan ws-merge__plan">
            <p class="ws-plan__head">${tx('ws.296')}</p>
            <div class="ws-mplan">
              <span class="ws-plan__badge" data-gc="1" aria-hidden="true">1</span>
              <button type="button" class="ws-mplan__name ws-mid" data-act="merge-name"><span class="ws-mid__a"></span><span class="ws-mid__b"></span></button>
              <span class="ws-row ws-merge__name" hidden>
                <input id="ws-merge-name" class="input" type="text" maxlength="120" autocomplete="off" spellcheck="false" aria-label="${tx('ws.243')}">
                <span class="ws-unit">.pdf</span>
              </span>
            </div>
            <p class="ws-plan__meta ws-merge__sum" aria-live="polite"></p>
          </div>
          <p class="ws-note">${icon('info', 16)}<span>${tx('ws.217')}</span></p>
          <div class="ws-actions ws-merge__actions">
            <p class="ws-set__msg ws-merge__msg" role="status" aria-live="polite"></p>
            <span class="ws-progress" hidden><span></span></span>
            <button type="button" class="btn btn--primary" data-act="merge-run">${icon('merge', 16)}<span>${tx('ws.245')}</span></button>
            <button type="button" class="btn" data-act="merge-cancel">${icon('close', 16)}<span>${tx('ws.246')}</span></button>
          </div>
          <p class="sr-only ws-merge__live" aria-live="polite"></p>
        </div>

        <div class="ws-actions">
          <p class="ws-set__msg" role="status" aria-live="polite"></p>
          <button type="button" class="btn btn--primary" data-act="apply">${icon('check', 16)}<span>${tx('ws.083')}</span></button>
          <button type="button" class="btn" data-act="revert">${icon('refresh', 16)}<span>${tx('ws.175')}</span></button>
          <button type="button" class="ws-link" data-act="apply-all" hidden><span></span></button>
        </div>
      </section>

      <!-- 가운데: 목록 -->
      <section class="ws-panel ws-listpanel" aria-labelledby="ws-list-title">
        <div class="ws-panel__head">
          <h3 id="ws-list-title">${icon('image', 18)}<span>${tx('ws.176')}</span></h3>
          <span class="ws-list__count muted"></span>
          <span class="ws-spacer"></span>
          <button type="button" class="btn btn--icon" data-act="clear" title="${tx('ws.177')}" hidden>${icon('trash', 18)}<span class="sr-only">${tx('ws.177')}</span></button>
        </div>
        <div class="ws-filter" role="group" aria-label="${tx('ws.178')}">
          ${FILTERS.map((f) => `<button type="button" class="ws-chip" data-filter="${f.id}" aria-pressed="${f.id === 'all'}">${f.label} <span class="ws-filter__n">0</span></button>`).join('')}
        </div>
        <div class="ws-pickbar" hidden>
          <button type="button" class="btn" data-act="merge" disabled>${icon('merge', 16)}<span>${tx('ws.226')}</span></button>
          <button type="button" class="ws-link" data-act="unpick" hidden>${tx('ws.229')}</button>
          <span class="ws-pickbar__hint muted">${tx('ws.230')}</span>
          <p class="ws-pickbar__warn" role="status" hidden></p>
        </div>
        <p class="ws-empty ws-list__empty">${tx('ws.179')}</p>
        <p class="ws-empty ws-list__filtered" hidden></p>
        <ul class="ws-list" aria-label="${tx('ws.180')}"></ul>
        <div class="ws-export">
          <p class="ws-list__sum muted" hidden></p>
          <button type="button" class="btn btn--primary" data-act="export" disabled>${icon('archive', 16)}<span>${tx('ws.128')}</span></button>
          <p class="muted ws-export__hint">${tx('ws.181')}</p>
          <p class="muted ws-export__hint ws-export__kept" role="status" hidden></p>
        </div>
      </section>

      <!-- 오른쪽: 결과 확인 -->
      <section class="ws-panel ws-view" aria-labelledby="ws-view-title">
        <div class="ws-panel__head">
          <h3 id="ws-view-title">${icon('compare', 18)}<span>${tx('ws.140')}</span></h3>
          <span class="ws-spacer"></span>
          <button type="button" class="btn btn--icon" data-act="zoom" aria-pressed="false" title="${tx('ws.182')}">${icon('zoom', 18)}<span class="sr-only">${tx('ws.182')}</span></button>
          <a class="btn btn--icon" data-act="view-download" title="${tx('ws.053')}" hidden>${icon('download', 18)}<span class="sr-only">${tx('ws.053')}</span></a>
        </div>
        <p class="ws-empty ws-view__empty">${tx('ws.183')}</p>
        <div class="ws-view__body" hidden>
          <p class="ws-view__file"></p>
          <div class="ws-cmp">
            <div class="ws-cmp__viewport">
              <div class="ws-cmp__stage">
                <img class="ws-cmp__before" alt="${tx('ws.184')}" draggable="false" decoding="async">
                <div class="ws-cmp__after-wrap"><img class="ws-cmp__after" alt="${tx('ws.113')}" draggable="false" decoding="async"></div>
                <div class="ws-cmp__divider" aria-hidden="true"></div>
                <span class="ws-cmp__label ws-cmp__label--left">${tx('ws.184')}</span>
                <span class="ws-cmp__label ws-cmp__label--right">${tx('ws.113')}</span>
              </div>
              <p class="ws-cmp__noimg muted"></p>
            </div>
            <input id="ws-range" class="ws-cmp__range" type="range" min="0" max="100" step="0.1" value="50" aria-label="${tx('ws.185')}">
            <p class="ws-cmp__caption muted"></p>
          </div>
          <div class="ws-view__status" data-tone="muted">
            <p class="ws-view__msg"></p>
            <span class="ws-progress" hidden><span></span></span>
          </div>
          <p class="ws-view__pctline"><span class="ws-view__pctlabel">${tx('ws.115')}</span> <span class="ws-badge ws-view__pct"></span></p>
          <table class="ws-stats">
            <thead><tr><th scope="col"><span class="sr-only">${tx('ws.186')}</span></th><th scope="col">${tx('ws.184')}</th><th scope="col">${tx('ws.113')}</th></tr></thead>
            <tbody></tbody>
          </table>
          <p class="ws-view__note muted" hidden></p>
          <!-- 합친 PDF: 바로 [압축] 탭으로 -->
          <div class="ws-view__next" hidden>
            <button type="button" class="btn btn--primary" data-act="next-compress">${icon('archive', 16)}<span>${tx('ws.297')}</span></button>
            <span class="ws-view__nexthint"></span>
          </div>
          <p class="ws-view__fine" hidden></p>
        </div>
      </section>
    </div>
  </section>`;
}
