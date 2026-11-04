/* ============================================================
   util.js — 화면 쪽 공용 도우미 (CSS 로드, 용량 표기)
   ============================================================ */

/** 앱 전용 CSS 를 한 번만 <link> 로 붙인다. path 는 사이트 루트 기준 (예: 'css/apps/x.css') */
export function loadCss(path) {
  if (document.querySelector(`link[data-app-css="${path}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL(`../../${path}`, import.meta.url).href;
  link.dataset.appCss = path;
  document.head.appendChild(link);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 2 : 1)} MB`;
}

/** 원본 대비 변화율. 줄면 '−42%', 늘면 '+3%' */
export function changeText(orig, out) {
  const pct = (1 - out / orig) * 100;
  if (Math.abs(pct) < 0.05) return '0%';
  const v = Math.abs(pct);
  return `${pct > 0 ? '−' : '+'}${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
}

/** 'photo.jpg' + 'webp' + '_min' → 'photo_min.webp' */
export function renameExt(name, ext, suffix) {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base}${suffix}.${ext}`;
}
