/* ============================================================
   appHost.js — 앱 마운트 호스트 (셸)
   ------------------------------------------------------------
   appRegistry 의 앱을 #app-root 에 마운트합니다. 지금은 작업실 하나라
   헤더에 기능 탭이 없습니다. 앱은 자기 영역(container) 안만 책임집니다.
   (예전 주소 #app=image / #app=resize / #app=pdf 도 작업실로 열립니다.)
   ============================================================ */

import { apps } from './appRegistry.js';

export function initAppHost() {
  const root = document.getElementById('app-root');
  const hashApp = new URLSearchParams(location.hash.slice(1)).get('app');
  const app = apps.find((a) => a.id === hashApp) || apps[0];
  if (!app) return;
  if (hashApp && hashApp !== app.id) history.replaceState(null, '', location.pathname + location.search);
  try {
    app.mount(root); // 한 화면뿐이라 정리 함수는 페이지를 떠날 때 브라우저가 대신한다
  } catch (err) {
    root.innerHTML = `<div class="card"><p class="muted">화면을 불러오지 못했습니다. (${app.id})</p></div>`;
    console.error('[app mount error]', app.id, err);
  }
}
