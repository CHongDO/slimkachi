/* ============================================================
   pageRanges.js — 쪽 범위 글 ↔ 쪽 번호 (화면·워커 공용, DOM 없음)
   ------------------------------------------------------------
   "1-3, 5, 8-10" 처럼 적은 글을 쪽 번호 묶음으로 풀고, 고른 쪽 번호를 다시 글로 만든다.
   쪽 번호는 1부터. 노드에서 그대로 시험할 수 있다.
   ============================================================ */

/**
 * 범위 글 → { groups, pages, bad }
 *  groups: 쉼표로 나눈 범위마다 쪽 번호 배열(오름차순) — '범위마다 따로' 나눌 때 그대로 쓴다
 *  pages : 모든 범위의 쪽 번호(중복 없이 오름차순) — 썸네일 선택 표시용
 *  bad   : 알아볼 수 없거나 1~total 밖인 조각 (화면이 안내)
 *  missing: bad 중 숫자는 맞지만 없는 쪽 번호 (조각마다 가장 벗어난 번호 — "15쪽은 없습니다" 안내용)
 * 허용: "3" · "1-3" · "3-1"(뒤집혀도 1-3) · "8-"(끝까지) · "-3"(처음부터) · 대시 대신 ~ – —
 */
export function parseRanges(text, total = Infinity) {
  const groups = [];
  const bad = [];
  const missing = [];
  const norm = String(text || '').replace(/\s*[-–—~〜]\s*/g, '-');
  for (const tok of norm.split(/[\s,，、;]+/)) {
    if (!tok) continue;
    const m = /^(\d*)-(\d*)$/.exec(tok) || /^(\d+)$/.exec(tok);
    if (!m) { bad.push(tok); continue; }
    let a, b;
    if (m.length === 2) { a = b = Number(m[1]); }
    else {
      if (!m[1] && !m[2]) { bad.push(tok); continue; }
      a = m[1] ? Number(m[1]) : 1;
      b = m[2] ? Number(m[2]) : total;
    }
    if (a > b) [a, b] = [b, a];
    if (!(a >= 1) || !Number.isFinite(b) || b > total) {
      bad.push(tok);
      if (Number.isFinite(b) && b > total) missing.push(b); else if (!(a >= 1)) missing.push(a);
      continue;
    }
    const g = [];
    for (let p = a; p <= b; p++) g.push(p);
    groups.push(g);
  }
  const pages = [...new Set(groups.flat())].sort((x, y) => x - y);
  return { groups, pages, bad, missing };
}

/** 오름차순 쪽 번호 → 이어진 구간 [[1,3],[5,5],[8,10]] */
export function runs(pages) {
  const out = [];
  for (const p of pages) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

/** 쪽 번호 → 범위 글 "1-3, 5, 8-10" */
export function formatRanges(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  return runs(sorted).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/** 파일 이름에 붙일 쪽 표시 "1-3_5_8-10" (너무 길면 "1-48_23p") */
export function fileLabel(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const label = runs(sorted).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join('_');
  if (label.length <= 32) return label;
  return `${sorted[0]}-${sorted[sorted.length - 1]}_${sorted.length}p`;
}

/** 1~total 쪽을 n쪽씩 자른 묶음 */
export function chunk(total, n) {
  const size = Math.max(1, Math.floor(n) || 1);
  const out = [];
  for (let a = 1; a <= total; a += size) {
    const g = [];
    for (let p = a; p <= Math.min(total, a + size - 1); p++) g.push(p);
    out.push(g);
  }
  return out;
}

/**
 * 나누기 설정 → 결과 파일마다 쪽 번호 묶음.
 *  method 'one'    고른 쪽만 PDF 하나로 · 'ranges' 범위마다 따로
 *         'every'  N쪽마다 자르기       · 'each'   한 쪽씩
 * 'every'·'each' 는 고른 쪽만 대상, 아무것도 안 골랐으면 전체 쪽.
 * total 을 모르는데(Infinity) 고른 쪽도 없으면 빈 배열 — 워커가 실제 쪽 수로 다시 계산한다.
 */
export function splitGroups({ method, text, every }, total) {
  const { groups, pages } = parseRanges(text, total);
  if (method === 'every' || method === 'each') {
    const target = pages.length ? pages
      : Number.isFinite(total) ? Array.from({ length: total }, (_, i) => i + 1) : [];
    const size = method === 'each' ? 1 : Math.max(1, Math.floor(Number(every)) || 1);
    const out = [];
    for (let i = 0; i < target.length; i += size) out.push(target.slice(i, i + size));
    return out;
  }
  if (method === 'ranges') return groups;
  return pages.length ? [pages] : [];
}

/** 같은 결과 파일 묶음 번호(0부터)마다 색 번호 1~GROUP_COLORS (theme.css --split-g1~6) */
export const GROUP_COLORS = 6;
export const groupColor = (i) => (i % GROUP_COLORS) + 1;
