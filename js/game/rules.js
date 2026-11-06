/* ============================================================
   game/rules.js — 까치런 규칙·물리 (화면 없음 — 노드에서 시뮬레이션으로 확인할 수 있게 DOM 을 모른다)
   ------------------------------------------------------------
   · 숫자는 모두 config.js. 단위는 칸·초, 고정 간격 STEP 으로만 움직인다(화면 주사율·PC 성능과 무관).
   · 점프: 땅에서 누르면 v0 로 뛰고, 올라가는 동안 누르고 있으면(최대 holdMax초) 중력이 약해져 더 높이.
     오르는 중에 한 번 놓으면 그 점프에서는 다시 길게 못 뜬다. 착지 직전 buffer초 안에 누른 것도 착지하자마자 뛴다.
   · 활강: 내려오는 중에 누르고 있으면 낙하 속도를 GLIDE.fall 까지 줄인다. 한 번 점프에 GLIDE.max초까지.
   · 공중 = 날갯짓 4프레임(활강 중은 활강 프레임), 땅 = 서기 ↔ 깡총.
   · 장애물 간격 ≥ 그 속도에서 '꾹 눌러 뛴 거리'(활강 없이) → 어떤 배치든 짧게·길게 뛰어 피할 수 있다.
   · 방패연은 까치 머리보다 위로 날아온다(달리면 아래로 지나감, 뛰면 걸림). '짧게 뛰어 넘을 장애물 바로 뒤'에 오는 쌍은
     짧게 뛰고 착지하면 아래로 지나가지만 길게 날거나 활강하면 걸린다. 800점부터 쌍이 늘고 단독 연 높이가 세 가지.
   · 같은 땅 장애물은 OBSTACLE.maxRepeat 번까지만 연속.
   · 반응 시간: 장애물이 화면 오른쪽 끝에 보인 뒤 까치에 닿기까지 VIEW.reactTime 초 이상 — 화면이 좁아 못 지키면
     그 폭에 맞춰 최고 속도를 낮춘다(speedCap). 화면 쪽은 먼저 칸 배율을 줄여 넓게 보여 준다(reachCells 로 확인).
   · DAYNIGHT.at 점수에 'daynight' 이벤트 한 번 — 화면 쪽이 게임 화면 안에서만 낮/밤을 바꾼다.
   · 부딪히면 까치마다 다른 조각이 떨어진다: 갓 쓴 까치 = 갓, 선비 까치 = 두루마리(화면 쪽이 펼쳐지는 그림으로).
   ============================================================ */

import { STEP, SPEED, JUMP, GLIDE, ANIM, SCORE, OBSTACLE, KITE, DAYNIGHT, CRASH, VIEW } from './config.js';
import { OBSTACLES, KITE_SPRITE, BIRDS, maskOf } from './sprites.js';

export { STEP };

const FLAP = ['up', 'mid', 'down', 'mid'];

/* 판정 칸 미리 계산: 까치마다 프레임마다 */
const MASKS = Object.fromEntries(Object.entries(BIRDS).map(([name, b]) => [
  name, Object.fromEntries(Object.entries(b.frames).map(([f, rows]) => [f, maskOf(rows, b.hit, b.tail)])),
]));
const KINDS = Object.entries(OBSTACLES).map(([name, o]) => ({ name, tier: o.tier, combo: o.combo, mask: maskOf(o.rows) }));
const KITE_MASK = maskOf(KITE_SPRITE.rows, KITE_SPRITE.hit);

/**
 * 까치 세로 움직임 한 칸 (점프 힘·길게 누르기·활강·중력). 착지하면 true.
 * b: { y, vy, air, holdT, glideT, gliding, airT }
 */
function moveBird(b, hold, dt) {
  b.airT += dt;
  const rising = b.vy > 0;
  const boost = hold && rising && b.holdT < JUMP.holdMax;
  if (boost) b.holdT += dt;
  else if (rising) b.holdT = JUMP.holdMax;                 // 오르는 중에 놓으면 이번 점프는 더 못 높인다
  b.gliding = !rising && hold && b.glideT < GLIDE.max;
  if (b.gliding) {
    b.glideT += dt;
    b.vy = b.vy < -GLIDE.fall
      ? Math.min(-GLIDE.fall, b.vy + GLIDE.brake * dt)   // 빨리 떨어지던 중이면 서서히 늦춘다
      : Math.max(-GLIDE.fall, b.vy - JUMP.gravity * dt);
  } else {
    b.vy -= (boost ? JUMP.holdGravity : JUMP.gravity) * dt;
  }
  b.y += b.vy * dt;
  if (b.y > 0) return false;
  b.y = 0; b.vy = 0; b.air = false; b.gliding = false;
  return true;
}

/** holdFor초 누른 점프(활강 없이)의 체공 시간 — 장애물 간격·연 배치 계산용 */
function airTime(holdFor) {
  const b = { y: 0, vy: JUMP.v0, air: true, holdT: 0, glideT: GLIDE.max, gliding: false, airT: 0 };
  let t = 0;
  while (!moveBird(b, t < holdFor, STEP)) t += STEP;
  return t + STEP;
}
/** 짧게 누른 점프(0.05초) · 꾹 누른 점프의 체공 시간(초) */
export const AIR = { tap: airTime(0.05), hold: airTime(JUMP.holdMax) };

/** 화면 폭(칸)에서 까치 위치(왼쪽 끝 칸) */
export function birdXFor(widthCells) {
  const bx = VIEW.birdX;
  return Math.max(bx.min, Math.min(bx.max, Math.round(widthCells * bx.ratio)));
}
/** 장애물이 화면 오른쪽 끝에서 까치 앞쪽 끝까지 오는 거리(칸) — 보이는 폭(소수 가능)으로 */
export function reachCells(visibleCells) {
  return visibleCells - birdXFor(visibleCells) - VIEW.birdW;
}
/** 그 속도에서 가장 빠른 장애물(방패연)이 보인 뒤 닿기까지 시간(초) */
export function reactTimeAt(visibleCells, speed) {
  return reachCells(visibleCells) / (speed * KITE.speed);
}
/** 반응 시간 VIEW.reactTime 을 지키는 최고 속도(칸/초) — SPEED.max 를 넘지 않음 */
export function speedCap(visibleCells) {
  return Math.min(SPEED.max, reachCells(visibleCells) / (VIEW.reactTime * KITE.speed));
}

/** visibleCells = 화면에 보이는 칸 수(화면 폭 ÷ 배율). 없으면 widthCells 로 어림 */
export function createWorld(widthCells, rand = Math.random, birdName = 'gat', visibleCells = widthCells - 1) {
  return {
    rand,
    width: widthCells,
    maxSpeed: speedCap(visibleCells),
    birdName: BIRDS[birdName] ? birdName : 'gat',
    birdX: birdXFor(widthCells),
    t: 0, speed: Math.min(SPEED.start, speedCap(visibleCells)), dist: 0, score: 0,
    bird: { y: 0, vy: 0, air: false, holdT: 0, glideT: 0, gliding: false, airT: 0, buffer: 0, frame: 'stand', drawY: 0 },
    obs: [], gap: 0, seq: 0,
    lastKind: '', repeat: 0,       // 바로 앞 땅 장애물 종류와 연속 횟수
    over: false, overT: 0, overShown: false, piece: null,
    milestone: 0, flipped: false,
  };
}

/** 화면 폭이 바뀌면 보이는 칸 수와 최고 속도 제한만 바꾼다 (까치 위치·진행 중인 판은 그대로) */
export function resize(w, widthCells, visibleCells = widthCells - 1) {
  w.width = widthCells;
  w.maxSpeed = speedCap(visibleCells);
}

/* 다음 장애물까지 간격(칸) — 그 속도의 '꾹 눌러 뛴 거리' × (gapMin ~ gapMin+gapSpread) + 여유 */
function nextGap(w, extra = 0) {
  const air = w.speed * AIR.hold;
  return Math.round(air * (OBSTACLE.gapMin + w.rand() * OBSTACLE.gapSpread) + OBSTACLE.gapPad + extra);
}

const pick = (w, list) => list[Math.floor(w.rand() * list.length)];

function addGround(w, k, x) {
  w.repeat = k.name === w.lastKind ? w.repeat + 1 : 1;
  w.lastKind = k.name;
  w.obs.push({ kind: k.name, x, y: 0, mask: k.mask, vx: 1, id: ++w.seq });
}
/** 땅 장애물 고르기 — 같은 종류가 maxRepeat 번 이어졌으면 그 종류는 빼고 (다른 후보가 있을 때만) */
function pickGround(w, list) {
  const rest = w.repeat >= OBSTACLE.maxRepeat ? list.filter((k) => k.name !== w.lastKind) : list;
  return pick(w, rest.length ? rest : list);
}
function addKite(w, x, y) {
  w.obs.push({ kind: 'kite', x, y, mask: KITE_MASK, vx: KITE.speed, bobT: w.rand() * 6, id: ++w.seq });
}

function spawn(w) {
  const [t1, t2] = OBSTACLE.tiers;
  const tier = w.score < t1 ? 0 : w.score < t2 ? 1 : 2;
  const x = w.width + OBSTACLE.spawnAhead;

  const late = w.score >= KITE.late.from;
  const r = w.score >= KITE.from ? w.rand() : 1;
  const pairP = late ? KITE.late.pair : KITE.pair;
  if (r < pairP + KITE.lone) {
    if (r < pairP) {
      // 짧게 뛰어 넘을 장애물 + 그 뒤 활강 높이로 오는 연.
      // 연이 까치 앞에 닿는 때 = 장애물이 까치를 다 지나간 때 + 짧은 점프 체공 절반 + 여유 (연은 KITE.speed 배 빠르다)
      const k = pickGround(w, KINDS.filter((o) => o.combo && o.tier <= tier));
      addGround(w, k, x);
      const passT = (x + k.mask.w - w.birdX) / w.speed;
      const arriveT = passT + AIR.tap * 0.5 + KITE.comboLate;
      addKite(w, w.birdX + 24 + KITE.speed * w.speed * arriveT, KITE.comboY);
    } else {
      addKite(w, x, pick(w, late ? KITE.late.ys : KITE.ys));
    }
    w.gap = nextGap(w, KITE.afterExtra);
    return;
  }
  const k = pickGround(w, KINDS.filter((o) => o.tier <= tier));
  addGround(w, k, x);
  w.gap = nextGap(w, k.mask.w * 0.5);
}

/** 판정: 두 칸 목록이 한 칸이라도 겹치나 (먼저 상자로 거른다) */
function hit(ax, ay, am, bx, by, bm) {
  if (ax + am.w <= bx || bx + bm.w <= ax || ay + am.h <= by || by + bm.h <= ay) return false;
  const set = new Set();
  for (const [x, y] of bm.cells) set.add((bx + x) * 4096 + (by + y));
  for (const [x, y] of am.cells) if (set.has((ax + x) * 4096 + (ay + y))) return true;
  return false;
}

/** 연 위아래 흔들림(-1·0·1칸) */
export const kiteBob = (o) => {
  const s = Math.sin(o.bobT * KITE.bobPeriod);
  return s > 0.35 ? 1 : s < -0.35 ? -1 : 0;
};

/**
 * 한 칸(STEP) 진행.
 * @param input { hold: 누르고 있는지, press: 이번에 새로 눌렀는지 }
 * @returns 이벤트 이름 배열 ('jump' | 'land' | 'crash' | 'milestone' | 'daynight' | 'over')
 */
export function step(w, input, dt = STEP) {
  const ev = [];
  const b = w.bird;
  if (w.over) {
    w.overT += dt;
    const p = w.piece;
    if (p && !p.rest) {
      p.t += dt;
      p.vy -= JUMP.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.y <= 0) { p.y = 0; p.rest = true; }
    } else if (p) p.t += dt;    // 땅에 닿은 뒤에도 두루마리는 마저 펼쳐진다
    if (w.overT >= CRASH.overDelay && !w.overShown) { w.overShown = true; ev.push('over'); }
    return ev;
  }

  w.t += dt;
  w.speed = Math.min(w.maxSpeed, SPEED.start + SPEED.acc * w.t);   // 좁은 화면은 반응 시간을 지키는 속도까지만
  const move = w.speed * dt;
  w.dist += move;
  w.score = Math.floor(w.dist * SCORE.perCell);
  const mile = Math.floor(w.score / SCORE.milestone);
  if (mile > w.milestone) { w.milestone = mile; ev.push('milestone'); }
  if (!w.flipped && w.score >= DAYNIGHT.at) { w.flipped = true; ev.push('daynight'); }

  /* 까치 */
  b.buffer = input.press ? JUMP.buffer : Math.max(0, b.buffer - dt);
  if (!b.air && b.buffer > 0) {
    Object.assign(b, { air: true, vy: JUMP.v0, holdT: 0, glideT: 0, airT: 0, buffer: 0 });
    ev.push('jump');
  }
  if (b.air && moveBird(b, input.hold, dt)) ev.push('land');
  b.frame = b.air
    ? (b.gliding ? 'glide' : FLAP[Math.floor(b.airT / ANIM.flapFrame) % 4])
    : (Math.floor(w.dist / ANIM.runStride) % 2 ? 'hop' : 'stand');
  const by = Math.round(b.y) + (!b.air && b.frame === 'hop' ? 1 : 0);
  b.drawY = by;

  /* 장애물 */
  for (const o of w.obs) {
    o.x -= move * o.vx;
    if (o.kind === 'kite') o.bobT += dt;
  }
  w.obs = w.obs.filter((o) => o.x + o.mask.w > -4);
  const last = w.obs[w.obs.length - 1];
  if (!last || w.width + OBSTACLE.spawnAhead - (last.x + last.mask.w) >= w.gap) spawn(w);

  /* 부딪힘 */
  const bm = MASKS[w.birdName][b.frame];
  for (const o of w.obs) {
    const oy = o.kind === 'kite' ? o.y + kiteBob(o) : o.y;
    if (!hit(w.birdX, by, bm, Math.round(o.x), oy, o.mask)) continue;
    w.over = true; w.overT = 0; w.overShown = false;
    // 그 프레임에서 떼어 낸 조각(갓·두루마리)이 뒤로 튕겨 올랐다가 떨어진다
    const pc = BIRDS[w.birdName].pieces[b.frame];
    w.piece = { frame: b.frame, x: w.birdX + pc.x, y: by + pc.y, vx: CRASH.pieceVx, vy: CRASH.pieceVy, t: 0, rest: false };
    ev.push('crash');
    break;
  }
  return ev;
}
