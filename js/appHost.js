/* ============================================================
   appHost.js — 앱 마운트 호스트 (셸)
   ------------------------------------------------------------
   appRegistry 의 앱을 #app-root 에 마운트합니다. 지금은 작업실 하나라
   헤더에 기능 탭이 없습니다. 앱은 자기 영역(container) 안만 책임집니다.
   (예전 주소 #app=image / #app=resize / #app=pdf 도 작업실로 열립니다.)
   헤더 [까치런] 버튼: 처음 누를 때만 js/game/kachiRun.js 를 import() 로 불러온다.
   ============================================================ */

import { apps } from './appRegistry.js';
import { t as tx } from './i18n/index.js';

export function initAppHost() {
  const root = document.getElementById('app-root');
  const hashApp = new URLSearchParams(location.hash.slice(1)).get('app');
  const app = apps.find((a) => a.id === hashApp) || apps[0];
  if (!app) return;
  if (hashApp && hashApp !== app.id) history.replaceState(null, '', location.pathname + location.search);
  try {
    app.mount(root); // 한 화면뿐이라 정리 함수는 페이지를 떠날 때 브라우저가 대신한다
  } catch (err) {
    root.innerHTML = `<div class="card"><p class="muted">${tx('app.001', { id: app.id })}</p></div>`;
    console.error('[app mount error]', app.id, err);
  }
  initGameButton();
}

/* 까치런: 게임 코드는 버튼을 처음 누를 때 받는다 (안 누르면 내려받지 않음) */
function initGameButton() {
  const btn = document.querySelector('[data-game-open]');
  if (!btn) return;
  let mod = null;
  btn.addEventListener('click', async () => {
    try {
      mod ||= import('./game/kachiRun.js');
      await (await mod).openGame(btn);
    } catch (err) {
      mod = null;   // 다음에 다시 받아 본다
      console.error('[kachi run]', err);
      alert(tx('kr.015'));
    }
  });
}
