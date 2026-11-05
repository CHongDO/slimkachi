/* ============================================================
   main.js — 진입점. 테마(낮/밤·배경) + 앱 호스트 초기화.
   ============================================================ */

import { initTheme } from './theme.js';
import { initAppHost } from './appHost.js';

function start() {
  initTheme();
  initAppHost();
}
// 영어·일본어 화면은 사전을 받느라(i18n 의 최상위 await) 이 모듈이 DOMContentLoaded 뒤에 실행될 수 있다
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
