/* ============================================================
   game/sprites.js — 까치런 픽셀 그림 (데이터만, DOM 없음)
   ------------------------------------------------------------
   · 주인공은 배경의 두 까치(js/magpie.js — 갓 쓴 까치·선비 까치) 그림을 그대로 쓴다(달리기·날갯짓·활강).
     부딪힐 때 떨어지는 조각(갓·두루마리)과 두루마리가 펼쳐지는 그림만 여기서 더 그린다.
   · 장애물(장독대·돌탑·짚단)과 방패연은 SlimKachi 가 새로 그린 칸 그림.
     글자 한 칸 = 그림 한 칸, '.' = 빈 칸. 색은 글자별 class → css/game.css 가 theme.css 변수로 칠한다.
   · hit: 부딪힘 판정에서 뺄 칸(그늘·연줄 같은 장식).
   ============================================================ */

import { SPECIES } from '../magpie.js';

/* 글자 → class (장애물·연 공용) */
export const CLS = {
  o: 'od', b: 'o', h: 'oh', d: 'os',          // 옹기: 테두리·몸통·빛·그늘
  D: 'sd', M: 's', L: 'sl',                   // 돌: 테두리·몸·빛
  Y: 'y', y: 'yd', r: 'yr',                   // 짚: 밝은 짚·어두운 짚·새끼줄
  F: 'kf', P: 'kp', R: 'kn', U: 'kb', A: 'ky', q: 'kq',   // 방패연: 대나무살·한지·꼭지·귀(파랑·노랑)·연줄
};

/** 여러 조각을 한 칸 그림으로 합친다 (뒤 조각이 앞 조각 위에 — '.' 은 덮지 않음) */
function compose(w, h, parts) {
  const g = Array.from({ length: h }, () => Array(w).fill('.'));
  for (const { rows, x, y } of parts) {
    rows.forEach((r, j) => [...r].forEach((c, i) => { if (c !== '.') g[y + j][x + i] = c; }));
  }
  return g.map((r) => r.join(''));
}

/* ---- 장독대: 돌 받침 위 옹기 ---- */
const JAR_BIG = [
  '....oooo....',
  '...obbbbo...',
  '..oooooooo..',
  '.obhbbbbbdo.',
  'obhhbbbbbbdo',
  'obhbbbbbbbdo',
  'obbbbbbbbbdo',
  'obbbbbbbbbdo',
  '.obbbbbbbdo.',
  '..obbbbbdo..',
  '...oooooo...',
];
const JAR_SMALL = [
  '..oooo..',
  '.oooooo.',
  'obhbbbdo',
  'obhbbbdo',
  'obbbbbdo',
  '.obbbdo.',
  '..oooo..',
];
const slab = (w) => ['L'.repeat(w), 'M'.repeat(w - 1) + 'D', 'D'.repeat(w)];

/* ---- 돌탑: 아래부터 [폭, 높이, 왼쪽 띄움] ---- */
function stone(w, h) {
  const rows = ['.' + 'D'.repeat(w - 2) + '.'];
  for (let i = 1; i < h - 1; i++) rows.push('D' + (i === 1 ? 'LL' + 'M'.repeat(w - 4) : 'M'.repeat(w - 2)) + 'D');
  rows.push('.' + 'D'.repeat(w - 2) + '.');
  return rows;
}
function cairn(stones) {
  const w = Math.max(...stones.map((s) => s[0] + s[2]));
  const h = stones.reduce((a, s) => a + s[1], 0);
  let y = h;
  const parts = stones.map(([sw, sh, dx]) => { y -= sh; return { rows: stone(sw, sh), x: dx, y }; });
  return compose(w, h, parts);
}

/* ---- 짚단: 가운데를 새끼줄로 묶은 볏짚 ---- */
const STRAW = [
  '.y.Y.y.Y.',
  'yYyYyYyYy',
  '.YyYYyYY.',
  '..YyYyY..',
  '...YyY...',
  '..rrrrr..',
  '..YyYYY..',
  '.YyYyYyY.',
  'YyYYyYYyY',
  'YyYyYyYyY',
  'yYyYYyYyY',
  'yyyyyyyyy',
];

/* ---- 방패연: 한지 + 대나무살, 가운데 방구멍, 위에 붉은 꼭지, 위 양쪽 귀. 오른쪽 아래로 연줄 ---- */
const KITE = [
  'FFFFFFFFFFFF....',
  'FUUPPRRPPAAF....',
  'FUPPRRRRPPAF....',
  'FPPPPRRPPPPF....',
  'FPPPPPPPPPPF....',
  'FPPPP..PPPPF....',
  'FPPP....PPPFq...',
  'FPPP....PPPF.q..',
  'FPPPP..PPPPF..q.',
  'FPPPPPPPPPPF...q',
  'FPPPPPPPPPPF....',
  'FFFFFFFFFFFF....',
];

/* 장애물 종류: tier = 점수가 오르면 나오는 단계 (0 처음부터 · 1 중간 · 2 나중)
   combo = 짧게 뛰어 넘을 수 있어 '바로 뒤에 연'을 붙일 수 있는 것 (rules.js spawn) */
export const OBSTACLES = {
  jarSmall: { tier: 0, combo: true, rows: compose(10, 10, [{ rows: JAR_SMALL, x: 1, y: 0 }, { rows: slab(10), x: 0, y: 7 }]) },
  strawOne: { tier: 0, combo: true, rows: STRAW },
  cairnLow: { tier: 0, combo: true, rows: cairn([[8, 4, 0], [6, 3, 1], [4, 3, 2]]) },
  jarBig:   { tier: 1, combo: true, rows: compose(14, 14, [{ rows: JAR_BIG, x: 1, y: 0 }, { rows: slab(14), x: 0, y: 11 }]) },
  jarPair:  { tier: 1, combo: true, rows: compose(22, 14, [{ rows: JAR_BIG, x: 1, y: 0 }, { rows: JAR_SMALL, x: 13, y: 4 }, { rows: slab(22), x: 0, y: 11 }]) },
  strawTwo: { tier: 1, combo: true, rows: compose(16, 12, [{ rows: STRAW, x: 0, y: 0 }, { rows: STRAW, x: 7, y: 0 }]) },
  cairnTall:{ tier: 2, combo: false, rows: cairn([[10, 4, 0], [8, 4, 1], [7, 3, 1], [5, 3, 3], [3, 2, 4]]) },
};
export const KITE_SPRITE = { rows: KITE, hit: 'q' };

/* ---- 까치 두 마리 (배경 까치 그림 재사용 — js/magpie.js 의 SPECIES) ----
   magpie.js 띠 순서: 0~3 날갯짓(위·가운데·아래·가운데) · 4 활강 · 5 서기 · 6 쪼기 · 7 깡총.
   달릴 때 = 서기 ↔ 깡총, 공중 = 날갯짓, 활강 = 활강 프레임.
   부딪히면 떨어지는 조각(piece): 갓 쓴 까치 = 갓(H)+갓끈(S), 선비 까치 = 물고 있던 두루마리(E·R·S, 펼쳐지며 떨어짐).
   bare = 그 프레임에서 조각을 뗀 모습. 조각 위치는 프레임마다 달라(선비 까치는 날 때 두루마리가 더 위) 프레임별로 잘라 둔다. */
const FRAME_INDEX = { up: 0, mid: 1, down: 2, glide: 4, stand: 5, hop: 7 };
const strip = (rows, keep) => rows.map((r, y) => [...r].map((c, x) => (keep(c, x, y, r) ? c : '.')).join(''));

/** 조각 칸만 남기고 둘레 빈칸을 잘라 낸 그림 + 위치 (x = 까치 그림 왼쪽에서, y = 발밑에서 아래 끝까지 칸) */
function cutPiece(rows, isPiece) {
  const only = strip(rows, isPiece);
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
  only.forEach((r, y) => [...r].forEach((c, x) => {
    if (c === '.') return;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }));
  return { rows: only.slice(y0, y1 + 1).map((r) => r.slice(x0, x1 + 1)), x: x0, y: rows.length - 1 - y1 };
}

/* 선비 까치 두루마리가 펼쳐지는 두 단계 (말린 두루마리의 오른쪽 아래 끝에 맞춰 그린다). K = 먹 글씨 */
const SCROLL_HALF = [
  'ESSSSE',
  'ESKKSE',
  'ESSSRE',
];
const SCROLL_OPEN = [
  'ESSSSSSSSE',
  'ESKKSKKKSE',
  'ESSSSSSSSE',
  'ESKKKSKSSE',
  'ESSSSSSSRE',
];

function makeBird(sp, { isPiece, hit, foot, unroll = [] }) {
  const frames = {}, bare = {}, pieces = {};
  for (const [k, i] of Object.entries(FRAME_INDEX)) {
    frames[k] = sp.frames[i];
    bare[k] = strip(sp.frames[i], (c, x, y, r) => !isPiece(c, x, y, r));
    pieces[k] = cutPiece(sp.frames[i], isPiece);
  }
  return { cls: sp.cls, frames, bare, pieces, unroll, hit, tail: 4, foot };
}

export const BIRD_NAMES = ['gat', 'seonbi'];
export const BIRDS = {
  gat: makeBird(SPECIES.gat, {
    isPiece: (c) => c === 'H' || c === 'S',
    hit: 'GS',          // 배 아래 그늘·갓끈은 판정에서 뺀다
    foot: 15,           // 발 가운데 칸 (착지 먼지 자리)
  }),
  seonbi: makeBird(SPECIES.seonbi, {
    // 두루마리 = 한지(S)·말린 끝(E), 그 사이 붉은 끈(R). 등의 붉은 매듭 R 은 몸이라 빼지 않는다
    isPiece: (c, x, y, r) => c === 'S' || c === 'E' || (c === 'R' && (r[x - 1] === 'E' || r[x + 1] === 'S')),
    hit: '',
    foot: 12,
    unroll: [SCROLL_HALF, SCROLL_OPEN],   // 떨어지는 동안 말림 → 반쯤 → 활짝
  }),
};

/** 칸 그림 → 인라인 SVG (같은 글자 가로 묶음을 class 별 path 하나로) */
export function gridSvg(rows, cls, className = '') {
  const w = rows[0].length, h = rows.length;
  const d = {};
  rows.forEach((row, y) => {
    for (let x = 0; x < w;) {
      const c = row[x];
      let n = 1;
      while (x + n < w && row[x + n] === c) n++;
      if (c !== '.') d[c] = (d[c] || '') + `M${x} ${y}h${n}v1h-${n}z`;
      x += n;
    }
  });
  const paths = Object.entries(d).map(([c, p]) => `<path class="${cls[c]}" d="${p}"/>`).join('');
  return `<svg class="${className}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" focusable="false" aria-hidden="true">${paths}</svg>`;
}

/** 부딪힘 판정용 칸 목록: [x, 아래에서 몇 번째 줄] (skip 글자·왼쪽 from 칸 미만은 뺌) */
export function maskOf(rows, skip = '', from = 0) {
  const h = rows.length, cells = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== '.' && !skip.includes(c) && x >= from) cells.push([x, h - 1 - y]);
  }));
  return { cells, w: rows[0].length, h };
}
