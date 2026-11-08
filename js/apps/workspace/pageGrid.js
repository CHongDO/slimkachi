/* ============================================================
   pageGrid.js — PDF 나누기 화면의 쪽 썸네일 격자 (화면 쪽)
   ------------------------------------------------------------
   · 칸 = 쪽 하나(버튼, aria-pressed = 고름). 누르면 고름/해제, Shift+누르기 = 마지막으로 누른 쪽부터 범위.
   · 범위마다 따로·N쪽마다면 같은 결과 파일 쪽끼리 같은 색 테두리 + 왼쪽 위 파일 번호 배지 (paint).
   · 썸네일은 보이는 칸만 그린다(IntersectionObserver, 격자 스크롤 안). 그림은 pdf.js(preview.js openPages)가
     한 장씩 차례로 그리고, 한 번 그린 그림은 항목(item.pageThumbs)에 남겨 다시 고를 때 바로 보인다.
   · 키보드: 격자 안에서 ←→↑↓·Home·End 로 이동(칸 하나만 Tab 으로 들어옴), Space·Enter 로 고름.
   상태(고른 쪽)는 화면(workspace.js)이 갖고, 이 모듈은 그리기와 입력만 한다.
   ============================================================ */

import { t as tx } from '../../i18n/index.js';

const CELL = 64;   // 칸 그림 긴 변(px, CSS 와 같게)

export class PageGrid {
  /**
   * @param {HTMLElement} root 격자(스크롤 칸)
   * @param {{ onPick({ pages:number[], select:boolean }), open(item): Promise<handle>, onFail(item) }} hooks
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.item = null;
    this.handleP = null;
    this.io = null;
    this.anchor = null;
    this.focusN = 1;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('.ws-page');
      if (!b) return;
      const n = Number(b.dataset.page);
      if (e.shiftKey && this.anchor && this.anchor !== n) {
        const a = this.tile(this.anchor);
        const select = !a || a.getAttribute('aria-pressed') === 'true';
        const [lo, hi] = this.anchor < n ? [this.anchor, n] : [n, this.anchor];
        this.hooks.onPick({ pages: Array.from({ length: hi - lo + 1 }, (_, i) => lo + i), select });
      } else {
        this.hooks.onPick({ pages: [n], select: b.getAttribute('aria-pressed') !== 'true' });
        this.anchor = n;
      }
      this.move(n, false);
    });
    root.addEventListener('keydown', (e) => {
      const b = e.target.closest('.ws-page');
      if (!b) return;
      const n = Number(b.dataset.page);
      const total = this.root.children.length;
      const cols = this.cols();
      const to = { ArrowLeft: n - 1, ArrowRight: n + 1, ArrowUp: n - cols, ArrowDown: n + cols, Home: 1, End: total }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      this.move(Math.min(total, Math.max(1, to)), true);
    });
  }

  tile(n) { return this.root.children[n - 1] || null; }
  cols() {
    const kids = this.root.children;
    if (kids.length < 2) return 1;
    const top = kids[0].offsetTop;
    let c = 1;
    while (c < kids.length && kids[c].offsetTop === top) c++;
    return c;
  }
  /** 칸 하나만 Tab 으로 들어오게 (roving tabindex) */
  move(n, focus) {
    const old = this.tile(this.focusN);
    if (old) old.tabIndex = -1;
    this.focusN = n;
    const t = this.tile(n);
    if (!t) return;
    t.tabIndex = 0;
    if (focus) { t.focus(); t.scrollIntoView({ block: 'nearest' }); }
  }

  /** item 의 쪽 칸을 그린다 (같은 항목·같은 쪽 수면 그대로 둔다) */
  show(item, pages) {
    if (this.item === item && this.root.children.length === pages) return;
    this.reset();
    this.item = item;
    if (!item.pageThumbs) item.pageThumbs = new Map();
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= pages; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-page';
      b.dataset.page = n;
      b.tabIndex = n === 1 ? 0 : -1;
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', tx('ws.062', { pages: n }));
      b.innerHTML = '<span class="ws-page__img"><img alt="" decoding="async" draggable="false"><span class="ws-page__g" aria-hidden="true"></span></span><span class="ws-page__n" aria-hidden="true"></span>';
      b.lastChild.textContent = n;
      const cached = item.pageThumbs.get(n);
      if (cached) b.querySelector('img').src = cached.url;
      frag.append(b);
    }
    this.root.append(frag);
    this.focusN = 1;
    this.anchor = null;
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        this.io.unobserve(en.target);
        this.load(Number(en.target.dataset.page));
      }
    }, { root: this.root, rootMargin: '160px 0px' });
    for (const b of this.root.children) if (!item.pageThumbs.has(Number(b.dataset.page))) this.io.observe(b);
  }

  async load(n) {
    const item = this.item;
    if (!item || item.pageThumbs.has(n)) return;
    if (!this.handleP) {
      this.handleP = this.hooks.open(item).catch((err) => {
        if (!err || err.name !== 'PasswordException') console.warn(err);
        if (this.item === item) { this.io && this.io.disconnect(); this.hooks.onFail(item); }
        return null;
      });
    }
    const h = await this.handleP;
    if (!h || this.item !== item) return;
    const px = Math.round(CELL * Math.min(2, window.devicePixelRatio || 1));
    const blob = await h.thumb(n, px);
    if (!blob || this.item !== item || item.pageThumbs.has(n)) return;
    const url = URL.createObjectURL(blob);
    item.pageThumbs.set(n, { blob, url });
    const t = this.tile(n);
    if (t) t.querySelector('img').src = url;
  }

  /** 지금 열어 둔 문서(item)의 n쪽 그림 Blob — 나눈 파일의 목록 썸네일에 쓴다 (문서를 새로 열지 않아 가볍다) */
  async pageBlob(item, n, size) {
    if (this.item !== item) return null;
    const cached = item.pageThumbs && item.pageThumbs.get(n);
    if (cached) return cached.blob;
    const h = this.handleP ? await this.handleP : null;
    return h && this.item === item ? h.thumb(n, size) : null;
  }

  /**
   * 칸 표시를 한 번에:
   *  pressed = 고른 쪽 Set · groups = 쪽 → 결과 파일 번호(0부터) Map (없으면 묶음 표시 없음)
   *  faint   = 아무것도 안 골라 '전체 쪽 대상'인 상태 (전체가 옅게 고른 것처럼)
   * 묶음 색은 data-gc(1~6 → theme.css --split-g1~6), 왼쪽 위 배지는 파일 번호.
   */
  paint({ pressed, groups = null, faint = false, colorOf = (i) => i + 1, label = null }) {
    this.root.classList.toggle('is-all', faint);
    for (const b of this.root.children) {
      const n = Number(b.dataset.page);
      b.setAttribute('aria-pressed', String(pressed.has(n)));
      const g = groups ? groups.get(n) : undefined;
      const badge = b.querySelector('.ws-page__g');
      if (g === undefined) { delete b.dataset.gc; badge.textContent = ''; }
      else { b.dataset.gc = colorOf(g); badge.textContent = g + 1; }
      if (label) b.setAttribute('aria-label', label(n, g));
    }
  }

  /** 다른 파일로 바뀔 때·화면을 닫을 때. 그린 그림은 항목에 남는다(항목을 지울 때 해제). */
  reset() {
    if (this.io) this.io.disconnect();
    this.io = null;
    if (this.handleP) this.handleP.then((h) => h && h.close());
    this.handleP = null;
    this.item = null;
    this.root.textContent = '';
  }
}
