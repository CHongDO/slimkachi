/* ============================================================
   main.js — 진입점. 테마(낮/밤·배경) + 앱 호스트 초기화.
   ============================================================ */

import { initTheme } from './theme.js';
import { initAppHost } from './appHost.js';

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initAppHost();
});
