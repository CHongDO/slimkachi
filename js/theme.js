/* ============================================================
   theme.js — 낮/밤 토글 + 배경 패럴랙스 (셸)
   ------------------------------------------------------------
   · 모드는 <head> 의 짧은 스크립트가 그리기 전에 이미 정해 둔다
     (저장한 값 → 없으면 prefers-color-scheme). 여기서는 토글과 변경만.
   · 저장은 localStorage('ft-mode'), 막힌 브라우저(사생활 모드 등)는 try/catch 로 무시.
   · 패럴랙스: .scene 안 [data-depth] 레이어를 스크롤×depth 만큼(정수 px) 올린다.
     모션 줄이기 설정이면 움직이지 않는다.
   · 탭이 백그라운드면 .scene 에 data-paused 를 붙여 배경 애니메이션을 멈춘다.
   · 달 모양 <html data-moon="full|crescent"> 은 <head> 스크립트가 열 때마다 50:50 으로 고른다(없으면 여기서).
     그 모양으로 js/moon.js 가 캔버스에 한 번 그린다.
   ============================================================ */

import { icon } from './icons.js';
import { drawMoons } from './moon.js';
import { initMagpie } from './magpie.js';

const KEY = 'ft-mode';
const MAX_SCROLL = 1200;   // 이 이상 내려가도 배경은 더 움직이지 않음

function readSaved() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function save(mode) {
  try { localStorage.setItem(KEY, mode); } catch { /* 저장 못 해도 이번 화면에는 적용 */ }
}

export function initTheme() {
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  /* ---- 낮/밤 토글 ---- */
  const btn = document.querySelector('[data-theme-toggle]');
  const sync = () => {
    if (!btn) return;
    const night = root.dataset.mode === 'night';
    const label = night ? '낮 모드로 바꾸기' : '밤 모드로 바꾸기';
    btn.setAttribute('aria-pressed', String(night));
    btn.title = label;
    btn.innerHTML = `${icon(night ? 'sun' : 'moon', 16)}<span class="sr-only">${label}</span>`;
  };
  const apply = (mode) => { root.dataset.mode = mode; sync(); };

  if (root.dataset.mode !== 'day' && root.dataset.mode !== 'night') apply(dark.matches ? 'night' : 'day');
  sync();
  btn?.addEventListener('click', () => {
    const next = root.dataset.mode === 'night' ? 'day' : 'night';
    apply(next);
    save(next);
  });
  // 직접 고른 적이 없으면 운영체제 설정을 계속 따라간다
  dark.addEventListener?.('change', (e) => {
    const s = readSaved();
    if (s !== 'day' && s !== 'night') apply(e.matches ? 'night' : 'day');
  });

  /* ---- 탭이 숨겨지면 배경 애니메이션 멈춤 ---- */
  const scenes = document.querySelectorAll('.scene');
  // 밤하늘 달: 보통 <head> 스크립트가 그리기 전에 이미 고른다(50:50). 없을 때만 여기서
  if (!root.dataset.moon) root.dataset.moon = Math.random() < 0.5 ? 'full' : 'crescent';
  drawMoons(root.dataset.moon);   // 페이지 로드 때 한 번만
  initMagpie();                   // 낮 하늘에 가끔 나는 갓 쓴 까치
  const pause = () => scenes.forEach((el) => el.toggleAttribute('data-paused', document.hidden));
  document.addEventListener('visibilitychange', pause);
  pause();

  /* ---- 패럴랙스 ---- */
  const layers = [...document.querySelectorAll('.scene [data-depth]')]
    .map((el) => ({ el, depth: Number(el.dataset.depth) || 0, y: -1 }));
  if (!layers.length) return;
  let raf = 0;
  const update = () => {
    raf = 0;
    const s = still.matches ? 0 : Math.min(Math.max(window.scrollY, 0), MAX_SCROLL);
    for (const l of layers) {
      const y = Math.round(s * l.depth);
      if (y !== l.y) { l.y = y; l.el.style.setProperty('--y', y); }
    }
  };
  addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
  still.addEventListener?.('change', update);
  update();
}
