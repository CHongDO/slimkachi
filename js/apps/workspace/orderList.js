/* ============================================================
   orderList.js — 합치기 순서 목록: 끌어서·키보드(↑↓)로 순서 바꾸기 (화면 쪽)
   ------------------------------------------------------------
   · 손잡이([data-grip])를 누른 채 끌면 줄이 따라 움직인다 (포인터 이벤트 — 마우스·터치·펜 모두).
   · 줄(li, tabindex 0)에 포커스가 있을 때 ↑ ↓ 로 한 칸씩 옮긴다.
   · 옮긴 뒤 onMove(from, to) — 실제 순서(상태)는 화면이 바꾸고 다시 그린다.
   ============================================================ */

export function sortable(ol, { onMove }) {
  let drag = null;
  const rows = () => [...ol.children];

  ol.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const li = grip.closest('li');
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    drag = { li, grip, pointer: e.pointerId, from: rows().indexOf(li) };
    li.classList.add('is-dragging');
  });
  ol.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const y = e.clientY;
    // 위 줄의 가운데보다 올라가면 그 앞으로, 아래 줄의 가운데보다 내려가면 그 뒤로
    let prev = drag.li.previousElementSibling;
    while (prev && y < mid(prev)) { ol.insertBefore(drag.li, prev); prev = drag.li.previousElementSibling; }
    let next = drag.li.nextElementSibling;
    while (next && y > mid(next)) { ol.insertBefore(next, drag.li); next = drag.li.nextElementSibling; }
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const { li, from } = drag;
    drag = null;
    li.classList.remove('is-dragging');
    const to = rows().indexOf(li);
    if (to !== from) onMove(from, to);
  };
  ol.addEventListener('pointerup', end);
  ol.addEventListener('pointercancel', end);

  ol.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const li = e.target.closest('li');
    if (!li || e.target !== li) return;
    const from = rows().indexOf(li);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= ol.children.length) return;
    e.preventDefault();
    onMove(from, to);
  });
}

const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
