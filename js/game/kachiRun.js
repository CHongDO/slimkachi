/* ============================================================
   game/kachiRun.js — 까치런 화면 (크롬 공룡 게임을 오마주한 미니게임)
   ------------------------------------------------------------
   · 헤더 [까치런] 버튼을 처음 누를 때 appHost.js 가 import() 로 불러온다(그 전에는 받지 않음).
   · 열면 <html data-game> → 작업실·소개·헤더·푸터 카드와 광고를 숨기고(css/game.css) 배경 장면을 화면 가득.
     작업실은 DOM 을 그대로 둔 채 숨기기만 하므로 올려 둔 파일·진행 중인 압축은 그대로 이어진다.
   · 규칙·물리는 rules.js, 숫자는 config.js, 그림은 sprites.js. 여기서는 입력·그리기·상태만.
   · 그리기: 인라인 SVG 조각을 transform 으로 옮긴다. 색은 css/game.css 가 theme.css 변수로 → 낮/밤을 그대로 따른다.
   · 대기 화면에서 까치 고르기(◀ ▶ · 키보드 ←/→): 갓 쓴 까치 / 선비 까치. 능력은 같고 부딪힐 때 떨어지는 것만 다르다.
     고른 까치는 localStorage('kachirun-bird'), 최고 기록은 까치별('kachirun-best-gat' · '-seonbi'). 막힌 브라우저는 try/catch.
   · requestAnimationFrame. 처리 워커가 일하는 중이면 30fps 로 줄인다(물리는 고정 간격이라 속도는 같음).
   · 탭이 숨겨지거나 창이 포커스를 잃으면 일시정지. Esc 또는 [작업실로 돌아가기]로 닫는다.
   · 모션 줄이기 설정이면 대기 화면에 안내만 하고 움직이지 않는다(누르면 그때 시작). 착지 먼지도 만들지 않는다.
   · 칸 배율: 4 → 3 → 2 중 '최고 속도에서도 반응 시간(VIEW.reactTime)을 지키는' 가장 큰 것. 2 로도 안 되면 rules 가 최고 속도를 낮춘다.
   · 속도감: 속도가 WIND.from 을 넘으면 하늘에 가로 바람 줄이 흐르고(빠를수록 많이), 자갈·착지 먼지가 속도에 비례해 길어진다.
     100점마다 점수판 깜빡임과 함께 까치 뒤로 바람 줄이 한 번 확 지나간다. 모션 줄이기면 바람 줄은 모두 끈다.
   · DAYNIGHT.at 점수에 게임 화면 안에서만 낮/밤을 한 번 바꾼다(<html data-mode> 만 잠시 바꾸고 저장값 ft-mode 는 건드리지 않음).
     판이 끝나 '다시' 안내가 뜰 때, 새 판을 시작할 때, 게임을 닫을 때 원래 모드로 돌린다.
     바뀔 때(와 '다시' 안내에서 돌아갈 때)는 DAYNIGHT.fade 초 동안 천천히(<html data-mode-fade>, theme.css), 새 판·닫기는 바로.
   ============================================================ */

import { t as tx } from '../i18n/index.js';
import { icon } from '../icons.js';
import { WorkerPool } from '../shared/workerPool.js';
import { GRASS_SURFACE } from '../magpie.js';
import { OBSTACLES, KITE_SPRITE, BIRDS, BIRD_NAMES, CLS, gridSvg } from './sprites.js';
import { createWorld, resize, step, kiteBob, reactTimeAt, STEP } from './rules.js';
import { SPEED, CRASH, DUST, VIEW, WIND, DAYNIGHT } from './config.js';

const BIRD_KEY = 'kachirun-bird';
const BEST_KEY = (name) => `kachirun-best-${name}`;
const OLD_BEST_KEY = 'kachirun-best';          // 까치 고르기 전의 기록 = 갓 쓴 까치 기록
const NAME_KEY = { gat: 'kr.017', seonbi: 'kr.018' };
const CRASH_KEY = { gat: 'kr.010', seonbi: 'kr.016' };
const FRAMES = ['stand', 'hop', 'up', 'mid', 'down', 'glide'];

const root = document.documentElement;
const still = matchMedia('(prefers-reduced-motion: reduce)');

const load = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, v) => { try { localStorage.setItem(key, String(v)); } catch { /* 저장 못 해도 이번에는 보인다 */ } };
const readBest = (name) => {
  const v = load(BEST_KEY(name)) ?? (name === 'gat' ? load(OLD_BEST_KEY) : null);
  return Math.max(0, parseInt(v, 10) || 0);
};
const readBird = () => { const v = load(BIRD_KEY); return BIRD_NAMES.includes(v) ? v : 'gat'; };
const pad = (n) => String(Math.min(n, 99999)).padStart(5, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** css/game.css 를 한 번만 불러 두고, 다 받을 때까지 기다린다 (스타일 없이 잠깐 보이는 것 방지) */
let cssReady = null;
function loadGameCss() {
  if (cssReady) return cssReady;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/game.css', import.meta.url).href;
  cssReady = new Promise((res) => { link.onload = res; link.onerror = res; });
  document.head.appendChild(link);
  return cssReady;
}

let game = null;
/** 헤더 버튼에서 부른다. opener = 닫을 때 포커스를 돌려줄 버튼 */
export async function openGame(opener) {
  await loadGameCss();
  game ||= createGame();
  game.open(opener);
}

/* 장애물 그림(SVG 문자열)은 종류마다 한 번만 만든다 */
const ART = Object.fromEntries([
  ...Object.entries(OBSTACLES).map(([k, o]) => [k, { svg: gridSvg(o.rows, CLS), w: o.rows[0].length, h: o.rows.length }]),
  ['kite', { svg: gridSvg(KITE_SPRITE.rows, CLS), w: KITE_SPRITE.rows[0].length, h: KITE_SPRITE.rows.length }],
]);

/** 까치 한 마리의 프레임 SVG 전부 (보통 모습 + 조각을 뗀 모습) */
function birdSvgs(name) {
  const b = BIRDS[name];
  return FRAMES.map((f) => gridSvg(b.frames[f], b.cls, `kr-f-${f}`) + gridSvg(b.bare[f], b.cls, `kr-f-bare-${f}`)).join('');
}

function createGame() {
  const el = document.createElement('div');
  el.className = 'kachirun';
  el.hidden = true;
  el.innerHTML = `
    <div class="kr__field" aria-hidden="true">
      <div class="kr__wind">${'<i hidden></i>'.repeat(WIND.max)}</div>
      <div class="kr__gust"></div>
      <div class="kr__obs"></div>
      <div class="kr__dust"></div>
      <div class="kr__spr kr__piece" hidden></div>
      <div class="kr__spr kr__bird" style="--w:24;--h:16"><div class="kr__bob"></div></div>
    </div>
    <div class="kr__soil" aria-hidden="true">${'<i></i>'.repeat(VIEW.pebbles)}</div>
    <div class="kr__stage" role="application" tabindex="0" aria-label="${esc(tx('kr.013'))}" aria-describedby="kr-panel">
      <div class="kr__panel card" id="kr-panel" aria-live="polite"></div>
    </div>
    <div class="kr__bar">
      <button type="button" class="btn kr__back">← ${esc(tx('kr.005'))} <kbd>Esc</kbd></button>
      <p class="kr__score card" aria-hidden="true">
        <span class="kr__hi">${esc(tx('kr.006'))} <span class="kr__best">00000</span></span>
        <span class="kr__now">00000</span>
      </p>
    </div>`;
  document.body.appendChild(el);

  const $ = (s) => el.querySelector(s);
  const stage = $('.kr__stage'), panel = $('.kr__panel'), obsBox = $('.kr__obs'), dustBox = $('.kr__dust');
  const bird = $('.kr__bird'), bob = $('.kr__bob'), pieceEl = $('.kr__piece'), back = $('.kr__back');
  const scoreBox = $('.kr__score'), nowEl = $('.kr__now'), bestEl = $('.kr__best');
  const pebbles = [...el.querySelectorAll('.kr__soil i')].map((p, i) => ({
    el: p, x: (i * 97 + 31) % 400, top: 2 + ((i * 7) % 5) * 2,   // 칸 단위 (보기 좋게 흩어 둔 고정 배치)
    base: i % 3 === 0 ? 2 : 1, shownW: '',                        // 기본 길이(칸) — 빨라지면 늘어난다
  }));
  const gustBox = $('.kr__gust');
  const winds = [...el.querySelectorAll('.kr__wind i')].map((n) => ({ el: n, on: false, x: 0, y: 0, len: 0, shownW: '' }));
  let windDist = 0;               // 바람 줄을 마지막으로 옮긴 때의 달린 거리

  let state = 'closed';         // wait · run · paused · over · closed
  let world = null, d = 4, cells = 400, visible = 400;
  let savedMode = null;          // 1200점 낮/밤 바꾸기 전의 모드 (바꾼 동안만 값이 있다)
  let birdName = readBird();
  const best = Object.fromEntries(BIRD_NAMES.map((n) => [n, readBest(n)]));
  let shownScore = -1, shownBest = -1, isNewBest = false, overReady = false;
  let shownFrame = '', pieceStage = -1;
  const input = { press: false, hold: false };
  const obsEls = new Map();      // 장애물 id → 요소
  let raf = 0, last = 0, acc = 0, blinkTimer = 0;
  let opener = null, savedScroll = 0;

  /* ---------- 까치 고르기 ---------- */
  function setBird(name) {
    birdName = name;
    el.dataset.bird = name;
    bob.innerHTML = birdSvgs(name);
    shownFrame = '';
    if (world) world.birdName = name;
    shownBest = -1;
  }
  function cycleBird(dir) {
    const i = BIRD_NAMES.indexOf(birdName);
    setBird(BIRD_NAMES[(i + dir + BIRD_NAMES.length) % BIRD_NAMES.length]);
    store(BIRD_KEY, birdName);
    world = createWorld(cells, Math.random, birdName, visible);
    draw();
    // 고르는 중인 버튼에서 포커스가 빠지지 않게 카드 전체가 아니라 글자만 바꾼다
    const nameEl = panel.querySelector('.kr__name');
    if (nameEl) nameEl.textContent = tx(NAME_KEY[birdName]);
    panel.querySelectorAll('.kr__bests [data-bird]').forEach((s) => s.classList.toggle('is-on', s.dataset.bird === birdName));
  }

  /* ---------- 크기: 칸 배율과 풀 면 위치 ---------- */
  function measure() {
    const vw = root.clientWidth || innerWidth;
    const vh = innerHeight;
    // 큰 배율부터: 최고 속도에서도 반응 시간을 지키는 첫 배율 (없으면 가장 작은 배율 + rules 의 속도 제한)
    const ok = (s) => (s < 4 || vh >= VIEW.scale4MinHeight) && reactTimeAt(vw / s, SPEED.max) >= VIEW.reactTime;
    d = VIEW.scales.find(ok) ?? VIEW.scales[VIEW.scales.length - 1];
    visible = vw / d;
    cells = Math.ceil(visible) + 1;
    const ground = document.querySelector('.scene__ground');
    const top = ground ? ground.getBoundingClientRect().top : vh - 64;
    el.style.setProperty('--kr-d', `${d}px`);
    el.style.setProperty('--kr-foot', `${Math.round(top + GRASS_SURFACE)}px`);
    if (world) resize(world, cells, visible);
  }

  /* ---------- DAYNIGHT.at 점수: 게임 화면 안에서만 낮 ↔ 밤 (저장값은 그대로) ---------- */
  let fadeTimer = 0;
  /** 모드 바꾸기. smooth 면 DAYNIGHT.fade 초 동안 색이 단계적으로 바뀐다 (모션 줄이기면 CSS 가 바로 바꾼다) */
  function setMode(mode, smooth) {
    clearTimeout(fadeTimer);
    if (smooth) {
      root.style.setProperty('--mode-fade', `${DAYNIGHT.fade}s`);
      root.style.setProperty('--mode-steps', String(DAYNIGHT.fadeSteps));
      root.setAttribute('data-mode-fade', '');
      fadeTimer = setTimeout(endFade, DAYNIGHT.fade * 1000 + 100);
    } else endFade();
    root.dataset.mode = mode;
  }
  function endFade() {
    root.removeAttribute('data-mode-fade');
    root.style.removeProperty('--mode-fade');
    root.style.removeProperty('--mode-steps');
  }
  function flipMode() {
    if (savedMode !== null) return;
    savedMode = root.dataset.mode || 'day';
    setMode(savedMode === 'night' ? 'day' : 'night', true);
  }
  function restoreMode(smooth = false) {
    if (savedMode === null) { if (!smooth) { clearTimeout(fadeTimer); endFade(); } return; }
    setMode(savedMode, smooth);
    savedMode = null;
  }

  /* ---------- 그리기 ---------- */
  const place = (node, xCells, yCells) => {
    node.style.transform = `translate(${Math.round(xCells * d)}px, ${-Math.round(yCells * d)}px)`;
  };

  function showFrame(f) {
    if (f === shownFrame) return;
    bob.querySelector(`.kr-f-${shownFrame}`)?.classList.remove('is-on');
    bob.querySelector(`.kr-f-${f}`)?.classList.add('is-on');
    bird.dataset.f = f;
    shownFrame = f;
  }

  /* 떨어지는 조각: 갓은 그대로, 두루마리는 말림 → 반쯤 → 활짝 (말린 두루마리의 오른쪽 아래 끝에 맞춰) */
  function drawPiece(w) {
    const p = w.piece;
    if (!p) { pieceEl.hidden = true; pieceStage = -1; return; }
    const b = BIRDS[w.birdName];
    const rolled = b.pieces[p.frame];
    const stageNo = Math.min(Math.floor(p.t / CRASH.unrollFrame), b.unroll.length);
    const rows = stageNo === 0 ? rolled.rows : b.unroll[stageNo - 1];
    if (stageNo !== pieceStage) {
      pieceStage = stageNo;
      pieceEl.innerHTML = gridSvg(rows, b.cls);
      pieceEl.style.setProperty('--w', rows[0].length);
      pieceEl.style.setProperty('--h', rows.length);
    }
    pieceEl.hidden = false;
    place(pieceEl, p.x + rolled.rows[0].length - rows[0].length, p.y);
  }

  function draw() {
    const w = world;
    const b = w.bird;
    showFrame(w.over ? `bare-${w.piece?.frame || 'stand'}` : b.frame);
    place(bird, w.birdX, b.drawY ?? 0);
    drawPiece(w);

    const alive = new Set();
    for (const o of w.obs) {
      alive.add(o.id);
      let node = obsEls.get(o.id);
      if (!node) {
        const art = ART[o.kind];
        node = document.createElement('div');
        node.className = `kr__spr kr__ob kr__ob--${o.kind === 'kite' ? 'kite' : 'ground'}`;
        node.style.cssText = `--w:${art.w};--h:${art.h}`;
        node.innerHTML = art.svg;
        obsBox.appendChild(node);
        obsEls.set(o.id, node);
      }
      place(node, o.x, o.kind === 'kite' ? o.y + kiteBob(o) : o.y);
    }
    for (const [id, node] of obsEls) if (!alive.has(id)) { node.remove(); obsEls.delete(id); }

    // 흙 위 자갈: 달린 거리만큼 왼쪽으로 (화면 폭을 넘으면 오른쪽에서 다시). 빠를수록 길게 늘어진다
    const span = cells + 8;
    const extra = Math.round(VIEW.pebbleStretch * fast(w));
    for (const p of pebbles) {
      const x = ((((p.x - w.dist) % span) + span) % span) - 4;
      p.el.style.transform = `translate(${Math.round(x * d)}px, ${p.top * d}px)`;
      const width = `${(p.base + extra) * d}px`;
      if (width !== p.shownW) { p.shownW = width; p.el.style.width = width; }
    }
    drawWind(w);
    showScore(w.score);
  }

  /** 시작 속도 0 ~ 최고 속도 1 */
  function fast(w) {
    return Math.max(0, Math.min(1, (w.speed - SPEED.start) / (SPEED.max - SPEED.start)));
  }

  /* 바람 줄: 속도가 WIND.from 을 넘으면 개수가 속도에 비례해 늘어난다. 땅보다 WIND.speed 배 빨리 흐르고,
     왼쪽으로 다 나가면 오른쪽에서 새 높이·길이로 다시. 줄 수가 줄면 남은 줄은 마저 지나간 뒤 사라진다 */
  function drawWind(w) {
    const moved = Math.max(0, w.dist - windDist) * WIND.speed;
    windDist = w.dist;
    const want = still.matches || w.speed <= WIND.from ? 0
      : Math.ceil(WIND.max * Math.min(1, (w.speed - WIND.from) / (SPEED.max - WIND.from)));
    const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    winds.forEach((l, i) => {
      if (l.on) {
        l.x -= moved;
        if (l.x + l.len < 0) l.on = false;
      }
      if (!l.on && i < want) {
        l.on = true;
        l.len = rnd(WIND.len[0], WIND.len[1]);
        l.y = rnd(WIND.y[0], WIND.y[1]);
        l.x = cells + rnd(0, Math.round(cells * 0.6));      // 화면 오른쪽 밖에서 흩어져 들어온다
      }
      l.el.hidden = !l.on;
      if (!l.on) return;
      const width = `${l.len * d}px`;
      if (width !== l.shownW) { l.shownW = width; l.el.style.width = width; }
      place(l.el, l.x, l.y);
    });
  }
  function clearWind() {
    for (const l of winds) { l.on = false; l.el.hidden = true; }
    windDist = world ? world.dist : 0;
    gustBox.textContent = '';
  }

  /* 100점마다: 까치 몸 높이에서 바람 줄 몇 개가 뒤(왼쪽)로 한 번 확 지나간다 */
  function gust() {
    if (still.matches) return;
    const b = world.bird;
    for (let i = 0; i < WIND.gust; i++) {
      const n = document.createElement('i');
      const len = 6 + ((i * 5) % 9);
      const x = world.birdX + 4 + ((i * 7) % 12);
      n.style.width = `${len * d}px`;
      n.style.left = `${x * d}px`;
      n.style.bottom = `${(Math.round(b.y) + 2 + i * 3) * d}px`;
      n.style.setProperty('--gx', `${-(x + len + 8) * d}px`);
      n.style.animationDuration = `${WIND.gustTime}s`;
      n.style.animationDelay = `${(i % 3) * 0.04}s`;
      gustBox.appendChild(n);
      setTimeout(() => n.remove(), (WIND.gustTime + 0.15) * 1000);
    }
  }

  function showScore(n) {
    if (n !== shownScore) { shownScore = n; nowEl.textContent = pad(n); }
    if (best[birdName] !== shownBest) { shownBest = best[birdName]; bestEl.textContent = pad(shownBest); }
  }

  function blink() {   // 100점마다 점수가 몇 번 깜빡인다 (모션 줄이기면 CSS 가 끈다) + 바람 줄 한 번
    gust();
    scoreBox.classList.remove('is-blink');
    void scoreBox.offsetWidth;
    scoreBox.classList.add('is-blink');
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => scoreBox.classList.remove('is-blink'), 1000);
  }

  /* 착지: 발밑에서 먼지 2~3개가 양옆으로 튄다 (모션 줄이기면 없음). 빠를수록 뒤로 길게 튄다 */
  function dust() {
    if (still.matches) return;
    const fx = (world.birdX + BIRDS[world.birdName].foot) * d;
    const back = 1 + DUST.stretch * fast(world);                // 뒤(왼쪽)로 튀는 거리 배수
    for (let i = 0; i < DUST.count; i++) {
      const p = document.createElement('i');
      const dir = i === 0 ? -1 : i === 1 ? 1 : -2;               // 왼쪽 · 오른쪽 · 왼쪽 멀리
      p.style.left = `${fx + dir * d}px`;
      p.style.setProperty('--dx', `${Math.round(dir * 2 * (dir < 0 ? back : 1)) * d}px`);
      p.style.setProperty('--dy', `${-(i === 2 ? 1 : 2) * d}px`);
      p.style.animationDuration = `${DUST.life}s`;
      dustBox.appendChild(p);
      setTimeout(() => p.remove(), DUST.life * 1000 + 50);
    }
  }

  /* ---------- 안내 카드 ---------- */
  function bestsHtml() {
    return `<p class="kr__bests">${BIRD_NAMES.map((n) => `<span data-bird="${n}"${n === birdName ? ' class="is-on"' : ''}>${esc(tx('kr.022', { name: tx(NAME_KEY[n]), n: pad(best[n]) }))}</span>`).join(' · ')}</p>`;
  }

  function showPanel(kind) {
    if (!kind) { panel.hidden = true; return; }
    let html = '';
    if (kind === 'wait') {
      html = `<h2>${esc(tx('kr.001'))}</h2>`
        + `<div class="kr__pick" role="group" aria-label="${esc(tx('kr.019'))}">`
        + `<button type="button" class="btn btn--icon kr__prev" data-dir="-1" title="${esc(tx('kr.020'))}" aria-label="${esc(tx('kr.020'))}">${icon('prev', 16)}</button>`
        + `<span class="kr__name" aria-live="polite">${esc(tx(NAME_KEY[birdName]))}</span>`
        + `<button type="button" class="btn btn--icon kr__next" data-dir="1" title="${esc(tx('kr.021'))}" aria-label="${esc(tx('kr.021'))}">${icon('next', 16)}</button>`
        + `</div><p class="kr__small kr__hint">${esc(tx('kr.023'))}</p>`
        + bestsHtml()
        + `<p class="kr__lead">${esc(tx('kr.002'))}</p>`
        + (still.matches ? `<p class="kr__note">${esc(tx('kr.009'))}</p>` : '')
        + `<p class="kr__small">${esc(tx('kr.003'))}</p><p class="kr__credit">${esc(tx('kr.004'))}</p>`;
    } else if (kind === 'paused') {
      html = `<h2>${esc(tx('kr.014'))}</h2><p class="kr__lead">${esc(tx('kr.008'))}</p>`;
    } else if (kind === 'over') {
      html = `<h2>${esc(tx(CRASH_KEY[world.birdName]))}</h2><p>${esc(tx('kr.011', { n: world.score }))}${isNewBest ? ` · <span class="kr__new">${esc(tx('kr.012'))}</span>` : ''}</p>`
        + bestsHtml()
        + `<p class="kr__lead">${esc(tx('kr.007'))}</p>`;
    }
    panel.innerHTML = html;
    panel.hidden = false;
  }
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dir]');
    if (btn && state === 'wait') cycleBird(Number(btn.dataset.dir));
  });

  /* ---------- 상태 ---------- */
  function clearField() {
    for (const node of obsEls.values()) node.remove();
    obsEls.clear();
    dustBox.textContent = '';
    clearWind();
  }

  function toWait() {
    halt();
    state = 'wait';
    el.dataset.state = 'wait';
    world = createWorld(cells, Math.random, birdName, visible);
    clearField();
    draw();
    showPanel('wait');
  }

  function start() {
    restoreMode();
    world = createWorld(cells, Math.random, birdName, visible);
    clearField();
    isNewBest = false; overReady = false;
    input.press = false;               // 시작 누름은 점프로 치지 않는다
    state = 'run';
    el.dataset.state = 'run';
    showPanel(null);
    stage.focus({ preventScroll: true });
    draw();
    loop();
  }

  function pause() {
    if (state !== 'run') return;
    halt();
    input.hold = false;
    state = 'paused';
    el.dataset.state = 'paused';
    showPanel('paused');
  }

  function resume() {
    state = 'run';
    el.dataset.state = 'run';
    input.press = false;
    showPanel(null);
    loop();
  }

  function onEvent(e) {
    if (e === 'milestone') blink();
    else if (e === 'land') dust();
    else if (e === 'daynight') flipMode();
    else if (e === 'crash') {
      el.dataset.state = 'over';
      const n = world.birdName;
      if (world.score > best[n]) { best[n] = world.score; isNewBest = true; store(BEST_KEY(n), best[n]); }
    } else if (e === 'over') {
      state = 'over';
      restoreMode(true);                 // 판이 끝나면 원래 테마로 (천천히)
      showPanel('over');
      setTimeout(() => { overReady = true; }, CRASH.readyDelay * 1000);   // 부딪힐 때 누르고 있던 손으로 바로 다시 시작하지 않게
    }
  }

  /* ---------- 고정 간격 루프 ---------- */
  function loop() {
    cancelAnimationFrame(raf);
    last = performance.now();
    acc = 0;
    raf = requestAnimationFrame(frame);
  }
  function halt() { cancelAnimationFrame(raf); raf = 0; }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // 처리 워커가 일하는 중이면 30fps 로 (화면 쪽 일을 줄여 압축을 덜 방해)
    if (now - last < 1000 / VIEW.busyFps - 1 && WorkerPool.anyBusy()) return;
    acc += Math.min((now - last) / 1000, VIEW.maxDt);   // 멈췄다 돌아와도 한 번에 maxDt 까지만
    last = now;
    while (acc >= STEP) {
      acc -= STEP;
      const ev = step(world, input, STEP);
      input.press = false;
      ev.forEach(onEvent);
    }
    draw();
    // 끝난 판은 조각이 떨어져 다 펼쳐지고 안내가 뜬 뒤 멈춘다
    const p = world.piece;
    const settled = !p || (p.rest && Math.floor(p.t / CRASH.unrollFrame) >= BIRDS[world.birdName].unroll.length);
    if (state === 'over' && settled) halt();
  }

  /* ---------- 입력: 스페이스·↑ / 화면 터치. 오를 때 누르고 있으면 더 높이, 내려올 때 누르고 있으면 활강 ---------- */
  function press() {
    if (state === 'wait') start();
    else if (state === 'paused') resume();
    else if (state === 'over') { if (overReady) start(); }
    else if (state === 'run') { input.press = true; input.hold = true; }
  }
  function release() { input.hold = false; }

  const isJumpKey = (e) => e.code === 'Space' || e.key === ' ' || e.key === 'ArrowUp';
  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (state === 'wait' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      cycleBird(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (!isJumpKey(e)) return;
    // 버튼(돌아가기·◀ ▶)에 포커스가 있을 때 스페이스는 그 버튼 누르기
    if (e.target instanceof HTMLButtonElement && el.contains(e.target) && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!e.repeat) press();
  }
  function onKeyUp(e) { if (isJumpKey(e)) release(); }
  const onHidden = () => { if (document.hidden) pause(); };
  const onBlur = () => pause();

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;   // ◀ ▶ 버튼은 시작이 아니라 까치 바꾸기
    e.preventDefault();
    stage.focus({ preventScroll: true });
    try { stage.setPointerCapture(e.pointerId); } catch { /* 일부 브라우저 */ }
    press();
  });
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());   // 길게 누르기 메뉴 막기
  back.addEventListener('click', () => close());

  /* ---------- 열기·닫기 ---------- */
  function open(from) {
    if (state !== 'closed') return;
    opener = from || null;
    savedScroll = scrollY;
    el.hidden = false;
    root.setAttribute('data-game', '');
    scrollTo(0, 0);
    measure();
    for (const n of BIRD_NAMES) best[n] = readBest(n);
    setBird(readBird());
    toWait();
    stage.focus({ preventScroll: true });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('visibilitychange', onHidden);
    addEventListener('blur', onBlur);
    addEventListener('resize', measure);
  }

  function close() {
    if (state === 'closed') return;
    halt();
    clearTimeout(blinkTimer);
    restoreMode();
    input.hold = false;
    state = 'closed';
    el.hidden = true;
    root.removeAttribute('data-game');
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('visibilitychange', onHidden);
    removeEventListener('blur', onBlur);
    removeEventListener('resize', measure);
    scrollTo(0, savedScroll);
    opener?.focus({ preventScroll: true });
  }

  return { open, close };
}
