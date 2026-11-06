/* ============================================================
   magpie.js — 낮 하늘의 까치 두 마리 (배경 장식, 셸)
   ------------------------------------------------------------
   · gat    : 갓 쓴 까치 (원래 까치, 날개 푸른 광택)
   · seonbi : 선비 까치 — 로고(SlimKachi)와 같은 디자인. 흑립(반투명 챙)·호박 구슬 갓끈·파란색 없음,
              부리에 붉은 끈 두루마리를 모든 프레임에서 물고 있다. 날갯짓이 느리고 활강이 길다(점잖게).
   · 둘 다 24×16 칸 픽셀 스프라이트 8프레임(날갯짓 4 · 활강 · 서기 · 쪼기 · 깡총)을 가로 띠 하나의
     인라인 SVG 로 만든다(프레임 사이 빈 칸 1줄). 색은 칸 종류별 class → scene.css 가 theme.css 변수로 칠한다.
     (선비 까치는 쪼기 프레임 자리에 서기를 넣고 쪼지 않는다 — 두루마리를 놓치지 않게)
   · 움직임은 '단계(phase)'의 연속: 단계마다 시작·끝 좌표와 동작(data-act)을 정하고 CSS 애니메이션
     (transform 만) 한 번을 돌린 뒤, animationend 에서 다음 단계로. 탭이 숨으면 .scene[data-paused] 로 같이 멈춘다.
   · 각자 따로 20~40초(모바일 40~80초)에 한 번. 방향·높이·속도 랜덤. 약 3번 중 1번은 카드 바깥 양옆 여백 풀밭에
     착지 → 3~6초(깡총·쪼기·뒤돌아보기 중 1~2개) → 날아올라 화면 밖으로. 여백이 좁은 화면은 착지하지 않는다.
   · 두 마리가 같은 자리에 앉지 않게 착지 자리(왼쪽·오른쪽 여백)를 예약한다. 화면에는 최대 2마리.
   · 밤 모드·모션 줄이기에서는 만들지도 날지도 않는다. 날던 중 밤이 되면 바로 사라진다.
   · 테스트용: 첫 비행은 갓 쓴 까치 3~5초, 선비 까치 11~13초 뒤(시차), 둘 다 가능하면 착지 (first, firstLands).
   · 까치런(js/game/)이 갓 쓴 까치 그림(SPECIES·CLS)과 풀 면 높이(GRASS_SURFACE)를 그대로 가져다 쓴다.
   ============================================================ */

const W = 24, H = 16;
const LAND_CHANCE = 1 / 3;
const GAP_S = { wide: [20, 40], small: [40, 80] };
export const GRASS_SURFACE = 20;   // 땅 띠 위에서 풀 면(빈틈없는 줄)까지: grass.svg 5줄째 × 4px — 발 밑이 여기에 닿는다

/* 칸 종류: K 검정(머리·등·꼬리·다리) · H 갓 · S 갓끈 · B 날개 푸른 광택 · W 흰 배·눈 · G 배 아래 그늘 */
export const CLS = { K: 'k', H: 'h', S: 's', B: 'b', W: 'w', G: 'g' };
const EMPTY = '........................';

/* 날 때 몸 (날개는 아래 덮어쓰기) */
const BASE = [
  '..................HHH...',   // 0  갓 대우(높은 원통)
  '..................HHH...',
  '..................HHH...',
  '................HHHHHHH.',   // 3  넓은 챙
  '..................SKKK..',   // 4  머리 · S = 갓끈
  '..................SKWKKK',   // 5  눈 · 부리
  '..........KKKKKKKKSKKK..',   // 6  등
  '..KKKKKKKKKKKKKKKKKS....',   // 7  긴 꼬리 · 갓끈이 턱 밑으로
  'KKKKKKKKKKKWWWWWWKKK....',   // 8  흰 배
  '.KKKKKK...KWWWWWWKK.....',
  '............GGGGG.......',
  EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
];

/* 날개 덮어쓰기: [시작 줄, 줄들] ('.' = 그대로) */
const WING = {
  up: [0, [
    '.......KKK..............',
    '.......KBBBK............',
    '........KBBBK...........',
    '.........KBBBK..........',
    '..........KBBBK.........',
    '...........KBBBBK.......',
  ]],
  mid: [5, [
    '..........KKKKKK........',
    '.........KBBBBBBK.......',
    '..........BBBBBK........',
  ]],
  down: [7, [
    '...........BBBBB........',
    '...........KBBBBK.......',
    '...........KBBBK........',
    '..........KBBBK.........',
    '..........KBBK..........',
    '.........KBBK...........',
    '.........KKK............',
    '.........K..............',
  ]],
  glide: [4, [                   // 활강: 날개를 뒤로 쭉 편 채
    '.....KKKKKKKK...........',
    '...KKBBBBBBBBKK.........',
    '.....KKBBBBBBBK.........',
  ]],
};

/* 땅 위 (발 밑 = 15줄째 아래 경계) */
const STAND = [
  '..................HHH...',
  '..................HHH...',
  '..................HHH...',
  '................HHHHHHH.',
  '..................SKKK..',
  '..................SKWKKK',
  '..................SKKK..',
  '...........KKKKKKKKS....',
  '.........KBBBBBBKKKK....',   // 접은 날개
  '..KKKKKKKBBBBBBKWWKK....',
  'KKKKKKKKKKBBBBKWWWWK....',
  '.KKKK.....KKKWWWWWK.....',
  '............GGGGG.......',
  '.............K..K.......',   // 다리
  '.............K..K.......',
  '.............KK.KK......',   // 발가락(앞쪽)
];
const PECK = [                   // 머리를 땅으로, 꼬리는 위로
  EMPTY, EMPTY, EMPTY,
  'KK......................',
  '.KKK....................',
  '...KKK..................',
  '.....KKK................',
  '.......KKKKKKK.....HHH..',
  '........KBBBBBKK...HHH..',
  '........KBBBBBBKK..HHH..',
  '.........KBBBBKWKHHHHHHH',
  '..........KWWWWWKKSKKK..',
  '...........GGGGG..SKWK..',
  '.............K.K..SKKK..',
  '.............K.K...SKK..',
  '.............KKKK....K..',
];
const HOP = [...STAND.slice(0, 13), '.............KKKK.......', EMPTY, EMPTY];   // 발을 접고 뜬 모습

/* 날개 덮어쓰기 공통: base 위에 [시작 줄, 줄들] ('.' = 그대로) */
function overlay(base, [y0, rows]) {
  const g = base.map((r) => r.split(''));
  rows.forEach((r, i) => [...r].forEach((c, x) => { if (c !== '.') g[y0 + i][x] = c; }));
  return g.map((r) => r.join(''));
}
const flying = (name) => overlay(BASE, WING[name]);

/* ---------- 선비 까치 (로고 SlimKachi 와 같은 디자인) ----------
   칸 종류: K 먹색(머리·등·꼬리·흑립) · T 흑립 반투명 챙 · W 흰 배·눈 · Y 호박 구슬 갓끈 · R 인주(갓끈 매듭·두루마리 끈)
           G 부리·다리 · S 한지 두루마리 · E 두루마리 말린 끝.  부리 앞(오른쪽 끝)에 두루마리 E R S 를 늘 문다. */
const SB_BASE = [
  '...............KKK......',   // 0  흑립 대우
  '...............KKK......',
  '...............KKK......',
  '............TTKKKKKTTT..',   // 3  반투명 넓은 챙
  '..............YKKKK.....',   // 4  호박 구슬
  '...............KKWK.....',   // 5  눈
  '..............YKKKKGGERS',   // 6  부리 + 두루마리
  '...............KKKK..ERS',
  '......KKKKKKKKKR........',   // 8  등 · 붉은 매듭
  '..KKKKKKKWWWWWK.........',   // 9  꼬리 · 흰 배
  'KKKK......WWWW..........',
  EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
];
const SB_WING = {
  up: [0, [
    '......KKK...............',
    '......KWWK..............',
    '.......KWWK.............',
    '........KKKK............',
    '.........KKKK...........',
    '..........KKKK..........',
    '...........KKKK.........',
    '............KKK.........',
  ]],
  mid: [6, [
    '........KKKKKK..........',
    '.......KWWKKKKK.........',
  ]],
  down: [9, [
    '...........KKKK.........',
    '..........KKKK..........',
    '.........KWWK...........',
    '........KWWK............',
    '........KKK.............',
  ]],
  glide: [5, [                   // 날개를 길게 펴고 미끄러지듯
    '....KKKKKKKKK...........',
    '..KKWWKKKKKKK...........',
    '....KKKKKKKKK...........',
  ]],
};
/* 서기 = 로고 그림 그대로 (오른쪽 4칸·아래 2칸 옮겨 발이 맨 아래 줄에) */
const SB_STAND = [
  EMPTY, EMPTY,
  '...........KKK..........',
  '...........KKK..........',
  '...........KKK..........',
  '........TTKKKKKTTT......',
  '..........YKKKK.........',
  '...........KKWK.........',
  '..........YKKKKGGERS....',
  '...........KKKK..ERS....',
  '........KKKRKK..........',
  '........KWW.WWW.........',
  '........KKK.WWW.........',
  '.....KKKKKK.WWW.........',
  '....KK.....G.G..........',
  '....KK.....G.G..........',
];
const SB_HOP = [...SB_STAND.slice(0, 14), '....KK..................', '....KK..................'];   // 다리를 접고 뜬 모습

/* 띠 순서 = CSS 의 프레임 번호: 0~3 날갯짓 · 4 활강 · 5 서기 · 6 쪼기 · 7 깡총 */
export const SPECIES = {
  gat: {
    cls: CLS,
    frames: [flying('up'), flying('mid'), flying('down'), flying('mid'), flying('glide'), STAND, PECK, HOP],
    first: [3000, 5000], firstLands: true,
    speed: { wide: [140, 190], small: [70, 100] },   // 비행 px/초
    glideSpeed: 210, glideSlope: 0.6, riseSpeed: 280,  // 활강·날아오르기 px/초, 활강 기울기(세로/가로)
    acts: ['hop', 'peck', 'turn'],
  },
  seonbi: {
    cls: { K: 'nk', T: 'nt', W: 'nw', Y: 'ny', R: 'nr', G: 'ng', S: 'ns', E: 'ne' },
    frames: [
      overlay(SB_BASE, SB_WING.up), overlay(SB_BASE, SB_WING.mid), overlay(SB_BASE, SB_WING.down), overlay(SB_BASE, SB_WING.mid),
      overlay(SB_BASE, SB_WING.glide), SB_STAND, SB_STAND, SB_HOP,
    ],
    first: [11000, 13000], firstLands: true,           // 갓 쓴 까치와 겹치지 않게 시차
    speed: { wide: [100, 135], small: [55, 75] },      // 느긋하게
    glideSpeed: 140, glideSlope: 0.32, riseSpeed: 190,  // 완만하고 긴 활강
    acts: ['hop', 'turn'],                              // 두루마리를 물고 있어 쪼지 않는다
    farSide: true,                                      // 들어온 반대편 여백에 앉는다 → 화면을 건너는 긴 활강
  },
};

/** 8프레임 띠(200×16 칸) SVG — 같은 색 칸을 가로로 묶어 class 별 path 하나씩 */
function spriteSvg(sp) {
  const d = {};
  sp.frames.forEach((rows, f) => {
    rows.forEach((row, y) => {
      for (let x = 0; x < W;) {
        const c = row[x];
        let n = 1;
        while (x + n < W && row[x + n] === c) n++;
        if (c !== '.') d[c] = (d[c] || '') + `M${f * (W + 1) + x} ${y}h${n}v1h-${n}z`;
        x += n;
      }
    });
  });
  const paths = Object.entries(d).map(([c, p]) => `<path class="${sp.cls[c]}" d="${p}"/>`).join('');
  return `<svg viewBox="0 0 ${(W + 1) * sp.frames.length} ${H}" shape-rendering="crispEdges" focusable="false">${paths}</svg>`;
}

export function initMagpie() {
  const scene = document.querySelector('.scene');
  if (!scene || scene.querySelector('.scene__magpie')) return;
  const spots = new Map();   // 착지 자리 예약: 까치 이름 → 'left' | 'right'
  for (const name of Object.keys(SPECIES)) startBird(scene, name, SPECIES[name], spots);
}

function startBird(scene, name, sp, spots) {
  const root = document.documentElement;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const small = matchMedia('(max-width: 720px)');

  // 땅(풀) 앞에 서야 하므로 장면 맨 앞쪽(꽃잎 바로 뒤)에 둔다
  const el = document.createElement('div');
  el.className = `scene__magpie scene__magpie--${name}`;
  el.innerHTML = `<span class="scene__magpie-bob"><span class="scene__magpie-dir"><span class="scene__magpie-win">${spriteSvg(sp)}</span></span></span>`;
  scene.insertBefore(el, scene.querySelector('.scene__fx'));

  const rand = (a, b) => a + Math.random() * (b - a);
  const night = () => root.dataset.mode === 'night';
  let queue = [], busy = false, timer = 0, first = true;

  const stop = () => { queue = []; busy = false; spots.delete(name); el.removeAttribute('data-fly'); };
  const play = (ph) => {
    const dx = ph.bx - ph.ax, dy = ph.by - ph.ay;
    const s = el.style;
    s.setProperty('--ax', `${ph.ax}px`); s.setProperty('--ay', `${ph.ay}px`);
    s.setProperty('--bx', `${ph.bx}px`); s.setProperty('--by', `${ph.by}px`);
    s.setProperty('--mdur', `${ph.dur.toFixed(2)}s`);
    s.setProperty('--ms', String(Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / 2))));   // 약 2px 씩
    if (ph.act === 'rise') spots.delete(name);   // 땅을 떠나면 자리 예약을 푼다
    el.dataset.act = ph.act;
    el.dataset.dir = ph.right ? 'right' : 'left';
    el.removeAttribute('data-fly');
    void el.offsetWidth;                         // 애니메이션 처음부터 다시
    el.setAttribute('data-fly', '');
  };
  const advance = () => {
    const ph = queue.shift();
    if (!ph) return stop();
    play(ph);
  };
  el.addEventListener('animationend', (e) => { if (e.target === el && e.animationName === 'scene-magpie-move') advance(); });
  // 밤이 되면(또는 모션 줄이기를 켜면) 날던·앉아 있던 까치를 바로 치운다
  new MutationObserver(() => { if (night()) stop(); }).observe(root, { attributes: true, attributeFilter: ['data-mode'] });
  still.addEventListener?.('change', () => { if (still.matches) stop(); });

  /* 카드 바깥 여백(달 자리와 같은 계산): (화면 - (셸 - 2×안쪽 여백))/2 - 카드 테두리·그림자 12px */
  const gutter = (vw) => {
    const cs = getComputedStyle(root);
    const shell = parseFloat(cs.getPropertyValue('--shell-max')) || 1340;
    const pad = parseFloat(cs.getPropertyValue('--space-4')) || 16;
    return (vw - shell + 2 * pad) / 2 - 12;
  };

  const plan = (wantLand) => {
    const d = small.matches ? 2 : 4;
    const w = W * d, h = H * d;
    const vw = root.clientWidth || innerWidth, vh = innerHeight;
    let right, sign, out, edge;
    const setDir = (r) => { right = r; sign = r ? 1 : -1; out = r ? -w - 8 : vw + 8; edge = r ? vw + 8 : -w - 8; };
    setDir(Math.random() < 0.5);                  // true = 왼쪽 → 오른쪽
    const sky = Math.round(vh * rand(0.24, 0.42));
    const speed = rand(...sp.speed[small.matches ? 'small' : 'wide']);
    const seg = (act, ax, ay, bx, by, v, dir = right) => ({
      act, ax: Math.round(ax), ay: Math.round(ay), bx: Math.round(bx), by: Math.round(by),
      dur: Math.max(0.3, Math.hypot(bx - ax, by - ay) / v), right: dir });
    const wait = (act, x, y, dur, dir = right) => ({ act, ax: x, ay: y, bx: x, by: y, dur, right: dir });
    const across = () => [seg('fly', out, sky, edge, sky, speed)];   // 그냥 가로질러 가기

    const g = gutter(vw);
    const ground = scene.querySelector('.scene__ground');
    if (!wantLand || small.matches || g < w + 8 || !ground) return across();

    // 다른 까치가 예약한 쪽은 피한다. 양쪽 다 차 있으면 착지하지 않고 지나간다.
    const taken = new Set([...spots].filter(([k]) => k !== name).map(([, v]) => v));
    const prefer = Math.random() < 0.5 ? ['left', 'right'] : ['right', 'left'];
    const side = prefer.find((v) => !taken.has(v));
    if (!side) return across();
    spots.set(name, side);
    // 먼 쪽 착지: 반대편에서 들어와 화면을 건너며 길게 활강한다 (선비 까치)
    if (sp.farSide) setDir(side === 'right');

    /* ---- 착지 비행 ---- */
    const footY = Math.round(ground.getBoundingClientRect().top) + GRASS_SURFACE;   // 풀 면
    const y = footY - h;                                                          // 서 있을 때 상자 위쪽
    let x = Math.round(side === 'left' ? g / 2 - w / 2 : vw - g / 2 - w / 2);
    const q = [];
    // 활강 시작점: 착지점에서 기울기만큼 뒤·위. 화면 밖이면 화면 끝에서 낮게 들어와 바로 활강
    const gx = x - sign * (y - sky) / sp.glideSlope;
    if ((gx - out) * sign > 0) {
      q.push(seg('fly', out, sky, gx, sky, speed));
      q.push(seg('glide', gx, sky, x, y, sp.glideSpeed));
    } else {
      q.push(seg('glide', out, y - Math.abs(x - out) * sp.glideSlope, x, y, sp.glideSpeed));
    }
    // 땅 위 3~6초: 이 까치가 하는 동작 중 1~2개 + 사이사이 서 있기
    const total = rand(3, 6);
    const acts = [...sp.acts].sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.5 ? 1 : 2);
    const groups = acts.map((a) => {
      if (a === 'peck') return [wait('peck', x, y, 1.3)];
      if (a === 'turn') return [wait('turn', x, y, rand(0.9, 1.4), !right)];
      const hops = [];                            // 깡총 1~2번, 한 번에 2칸씩 앞으로
      for (let i = 0, n = Math.random() < 0.5 ? 1 : 2; i < n; i++) {
        hops.push({ ...seg('hop', x, y, x + sign * 2 * d, y, 1), dur: 0.6 });
        x += sign * 2 * d;
      }
      return hops;
    });
    const used = groups.flat().reduce((s, p) => s + p.dur, 0);
    const rest = Math.max(0.5, (total - used) / (groups.length + 1));
    let at = q.at(-1);
    q.push(wait('stand', at.bx, at.by, rest));
    for (const grp of groups) {
      // 앞 동작이 깡총으로 자리를 옮겼으면 그 자리에서 이어서
      grp.forEach((p) => { if (p.act !== 'hop') { p.ax = p.bx = at.bx; } q.push(p); at = p; });
      q.push(wait('stand', at.bx, at.by, rest));
    }
    // 퍼덕이며 비스듬히 날아오른 뒤, 남은 거리는 보통 비행으로 진행 방향 화면 밖까지
    const far = Math.abs(edge - x);
    const climbX = Math.min(far, 360);
    const top = y - Math.min(climbX * 0.7, y - vh * 0.2);
    q.push(seg('rise', x, y, x + sign * climbX, top, sp.riseSpeed));
    if (far > climbX) q.push(seg('fly', x + sign * climbX, top, edge, top, speed));
    return q;
  };

  const fly = (land) => { queue = plan(land); busy = true; advance(); };
  const next = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
  const gap = () => rand(...GAP_S[small.matches ? 'small' : 'wide']) * 1000;
  function tick() {
    if (still.matches || night()) { stop(); return next(gap()); }
    if (document.hidden || busy) return next(5000);
    fly(first && sp.firstLands ? true : Math.random() < LAND_CHANCE);
    first = false;
    next(gap());
  }
  next(rand(...sp.first));
}
