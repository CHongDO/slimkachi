/* ============================================================
   moon.js — 밤하늘 달을 캔버스에 픽셀 단위로 그린다 (외부 이미지 없음)
   ------------------------------------------------------------
   · 56×56 칸(달 지름 40칸 + 둘레 빛 번짐)에 한 번만 그리고, CSS 가 --orb 에 맞춰
     정수배(112px = 2배, 56px = 1배)로 image-rendering: pixelated 확대한다. 매 프레임 다시 그리지 않는다.
   · 픽셀 밝기 = 값 노이즈 3겹(얼룩) − 바다(불규칙한 큰 덩어리) + 왼쪽 위 하이라이트 × 가장자리 어둡게
     → theme.css 의 --moon-* 7톤으로 양자화. 가장자리 한 줄은 아주 연한 테두리 빛(--moon-rimlight).
   · 빛 번짐: 디더링 없이 원형 계단 링 3겹(0.16 → 0.08 → 0.04, --moon-glow). 초승달은 더 약하게.
   · 초승달은 같은 그림에 명암 경계(terminator)를 적용 — 경계 근처는 한두 톤 어둡게.
     밝은 쪽은 오른쪽 아래, 명암 경계는 세로에서 40° 기울어 오목한 쪽이 왼쪽 위를 향한다(저녁 초승달).
     어두운 쪽은 완전히 투명(하늘이 그대로 보임)하고, 빛 번짐도 밝은 부분에서 떨어진 거리로만 퍼져
     달 전체의 둥근 윤곽이 드러나지 않는다. 오목한 안쪽에는 작은 별 몇 개(--scene-star).
   · 고정 시드라 언제 그려도 같은 무늬.
   ============================================================ */

const N = 56;                 // 캔버스 칸 수 (화면 폭과 무관하게 고정)
const C = N / 2;              // 중심
const R = 20;                 // 달 반지름(칸) → 지름 40칸
const SEED = 20251104;
const GLOW = { full: [0.16, 0.08, 0.04], crescent: [0.10, 0.05, 0.025] };   // 링 3겹 불투명도
const RING = [2.5, 5, 8];     // 링 바깥 경계(달 가장자리에서 칸 수)
const TILT = 40 * Math.PI / 180;   // 초승달: 밝은 쪽 방향 = 오른쪽에서 아래로 40° (명암 경계가 세로에서 40° 기울어짐)
const LIT = [Math.cos(TILT), Math.sin(TILT)];   // 화면 좌표(y 아래)에서 밝은 쪽 방향
// 초승달 오목한 안쪽(왼쪽 위)의 작은 별: [x, y, 밝기] — 밝은 부분·빛 번짐과 겹치지 않는 자리
const CRESCENT_STARS = [[17, 18, 1, true], [24, 12, 0.7], [12, 27, 0.55]];

/* ---- 고정 시드 난수 + 값 노이즈 ---- */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function valueNoise(rand, cells) {
  const g = Array.from({ length: (cells + 1) * (cells + 1) }, rand);
  const at = (i, j) => g[j * (cells + 1) + i];
  const fade = (t) => t * t * (3 - 2 * t);
  return (u, v) => {             // u, v: 0..1
    const x = u * cells, y = v * cells;
    const i = Math.min(cells - 1, Math.floor(x)), j = Math.min(cells - 1, Math.floor(y));
    const fx = fade(x - i), fy = fade(y - j);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return a + (b - a) * fy;
  };
}

/* 실제 달 앞면처럼 왼쪽 위·가운데에 몰린 바다 (x, y: -1..1, r: 반지름, w: 진하기) */
const MARIA = [
  [-0.38, -0.30, 0.34, 1.0],   // 비의 바다
  [ 0.10, -0.32, 0.20, 0.9],   // 맑음의 바다
  [ 0.30, -0.02, 0.24, 0.9],   // 고요의 바다
  [-0.62,  0.08, 0.30, 0.8],   // 폭풍의 대양
  [ 0.52, -0.30, 0.13, 0.8],   // 위기의 바다
  [ 0.18,  0.30, 0.16, 0.6],   // 풍요의 바다
  [-0.22,  0.32, 0.14, 0.6],   // 구름의 바다
];

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    // 어두운 것 → 밝은 것 (7톤)
    tones: ['--moon-mare-deep', '--moon-mare', '--moon-rim', '--moon-mid', '--moon-base', '--moon-highland', '--moon-shine'].map(v),
    rimlight: v('--moon-rimlight'),
    glow: v('--moon-glow'),
    star: v('--scene-star'),
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {'full'|'crescent'} phase
 */
export function drawMoon(canvas, phase = 'full') {
  canvas.width = N; canvas.height = N;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, N, N);
  const col = readColors();
  if (col.tones.some((c) => !c) || !col.rimlight || !col.glow) return;   // 색 변수가 없으면 그리지 않음

  const rand = mulberry32(SEED);
  const n1 = valueNoise(rand, 4), n2 = valueNoise(rand, 9), n3 = valueNoise(rand, 19);
  const warp = valueNoise(rand, 6);
  const crescent = phase === 'crescent';
  // 초승달: 빛이 오른쪽 아래 뒤에서 (z<0 = 뒤쪽이라 가는 초승달). 두께는 예전과 같게 화면 성분 0.82
  const L = crescent ? [0.82 * LIT[0], 0.82 * LIT[1], -0.57] : [0, 0, 1];
  const SHINE = crescent ? [0.40 * LIT[0], 0.40 * LIT[1]] : [-0.42, -0.42];   // 하이라이트는 밝은 쪽에
  const Rr = R - 0.25;
  const inDisc = (x, y) => (x + 0.5 - C) ** 2 + (y + 0.5 - C) ** 2 <= Rr * Rr;

  // 1) 몸통: 칸마다 톤(0~6) 또는 -1(어두운 쪽) 계산
  const tone = new Int8Array(N * N).fill(-2);   // -2 = 달 밖
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!inDisc(x, y)) continue;
      const dx = (x + 0.5 - C) / Rr, dy = (y + 0.5 - C) / Rr;
      const z = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
      const u = (x + 0.5 - (C - R)) / (2 * R), v = (y + 0.5 - (C - R)) / (2 * R);

      const tex = n1(u, v) * 0.55 + n2(u, v) * 0.30 + n3(u, v) * 0.15;          // 얼룩
      const wx = dx + (warp(u, v) - 0.5) * 0.28, wy = dy + (warp(v, u) - 0.5) * 0.28;
      let mare = 0;
      for (const [mx, my, mr, mw] of MARIA) {
        const d = Math.hypot(wx - mx, wy - my) / mr;
        mare = Math.max(mare, mw * Math.max(0, 1 - d * d));
      }
      mare = Math.min(1, mare * 1.6);
      const tycho = Math.max(0, 1 - Math.hypot(dx + 0.10, dy - 0.62) / 0.07);   // 작은 밝은 충돌구
      const shine = Math.max(0, 1 - Math.hypot(dx - SHINE[0], dy - SHINE[1]) / 0.80);   // 하이라이트

      let b = 0.74 + (tex - 0.5) * 0.45 - mare * 0.30 + tycho * 0.18 + shine * shine * 0.30;
      b *= 0.80 + 0.20 * Math.pow(z, 0.5);                                     // 가장자리 살짝 어둡게

      if (crescent) {
        const dot = dx * L[0] + dy * L[1] + z * L[2];
        if (dot <= 0) { tone[y * N + x] = -1; continue; }                      // 어두운 쪽
        b *= 0.62 + 0.38 * Math.min(1, dot / 0.28);                            // 경계 근처는 한두 톤 어둡게
      }
      tone[y * N + x] = Math.max(0, Math.min(6, Math.floor(b * 7)));
    }
  }
  const lit = (x, y) => x >= 0 && y >= 0 && x < N && y < N && tone[y * N + x] >= 0;
  // 초승달 뿔 끝에서 떨어져 나온 외톨이 밝은 칸은 지운다 (상하좌우에 밝은 칸이 없으면)
  if (crescent) {
    const lonely = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (lit(x, y) && !lit(x - 1, y) && !lit(x + 1, y) && !lit(x, y - 1) && !lit(x, y + 1)) lonely.push(y * N + x);
    }
    for (const i of lonely) tone[i] = -1;
  }

  // 2) 빛 번짐: 밝은 부분 가장자리에서 떨어진 거리로 계단 링 3겹.
  //    초승달은 어두운 쪽 안쪽까지 같은 거리 규칙으로 — 원판 경계에서 끊기면 둥근 윤곽이 드러나므로
  const litPts = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (lit(x, y)) litPts.push([x, y]);
  const alphas = GLOW[crescent ? 'crescent' : 'full'];
  ctx.fillStyle = col.glow;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (tone[y * N + x] >= 0) continue;
      let d;
      if (!crescent) d = Math.hypot(x + 0.5 - C, y + 0.5 - C) - Rr;          // 보름달: 동심원
      else { d = Infinity; for (const [px, py] of litPts) d = Math.min(d, Math.hypot(x - px, y - py)); d -= 0.5; }
      const ring = RING.findIndex((r) => d <= r);
      if (ring < 0) continue;
      ctx.globalAlpha = alphas[ring];
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // 3) 몸통 칠하기 + 가장자리 한 줄 테두리 빛
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const t = tone[y * N + x];
      if (t === -2) continue;
      if (t === -1) continue;                        // 어두운 쪽: 완전히 투명 (하늘이 그대로)
      ctx.globalAlpha = 1; ctx.fillStyle = col.tones[t]; ctx.fillRect(x, y, 1, 1);
      const edge = !inDisc(x - 1, y) || !inDisc(x + 1, y) || !inDisc(x, y - 1) || !inDisc(x, y + 1);
      if (edge) { ctx.globalAlpha = 0.55; ctx.fillStyle = col.rimlight; ctx.fillRect(x, y, 1, 1); }
    }
  }
  // 4) 초승달 오목한 안쪽의 작은 별
  if (crescent && col.star) {
    ctx.fillStyle = col.star;
    for (const [x, y, a, cross] of CRESCENT_STARS) {
      ctx.globalAlpha = a;
      ctx.fillRect(x, y, 1, 1);
      if (cross) {
        ctx.globalAlpha = a * 0.45;
        ctx.fillRect(x - 1, y, 1, 1); ctx.fillRect(x + 1, y, 1, 1); ctx.fillRect(x, y - 1, 1, 1); ctx.fillRect(x, y + 1, 1, 1);
      }
    }
  }
  ctx.globalAlpha = 1;
}

/** .scene__moon canvas 를 모두 그린다 (페이지 로드 때 한 번) */
export function drawMoons(phase) {
  document.querySelectorAll('.scene__moon canvas').forEach((c) => drawMoon(c, phase));
}
