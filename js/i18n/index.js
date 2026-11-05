/* ============================================================
   i18n/index.js — 화면 문구 사전 (한국어 ko · 영어 en · 일본어 ja)
   ------------------------------------------------------------
   · 화면 쪽: <html lang="ko|en|ja"> 로 언어를 고른다. 이 모듈이 처음 불릴 때(최상위 await)
     그 언어 사전을 불러 두므로, 이 모듈을 import 한 모듈은 처음부터 tx() 를 쓸 수 있다.
   · 워커 쪽: document 가 없어 처음엔 한국어. 화면이 작업마다 lang 을 함께 보내고
     workerHost 가 setLang() 을 기다린 뒤 처리한다(엔진은 처리 중에만 tx() 를 부른다).
   · tx('키', { 이름: 값 }) — 사전 값의 {이름} 자리에 값을 넣는다. 사전 값이 함수면 그 함수로 만든다
     (숫자·단위 표기처럼 언어마다 규칙이 다른 것).
   · 키가 그 언어 사전에 없으면 한국어 → 그래도 없으면 키 그대로.
   · 한국어 사전은 원래 코드의 문구를 그대로 옮긴 것이다(글자 하나 다르지 않게).
   ============================================================ */

import ko from './ko.js';

export const LANGS = ['ko', 'en', 'ja'];
const LOCALE = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' };

let lang = 'ko';
let dict = ko;

/** 사전 바꾸기 (워커: 작업마다 화면이 보낸 언어로) */
export async function setLang(next) {
  const l = LANGS.includes(next) ? next : 'ko';
  if (l === lang) return;
  dict = l === 'ko' ? ko : (await import(`./${l}.js`)).default;
  lang = l;
}

export const getLang = () => lang;
export const locale = () => LOCALE[lang];

/** 문구 꺼내기 */
export function t(key, params) {
  let v = dict[key];
  if (v === undefined) v = ko[key];
  if (v === undefined) return key;
  if (typeof v === 'function') return v(params || {}, LOCALE[lang]);
  if (!params) return v;
  return v.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// 화면 쪽은 <html lang> 으로 바로 정한다 (워커에는 document 가 없음)
const docLang = typeof document !== 'undefined' ? (document.documentElement.lang || '').slice(0, 2).toLowerCase() : '';
await setLang(docLang);
