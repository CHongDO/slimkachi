/* ============================================================
   open.js — 문서(HWP·HWPX·DOCX·PPTX·XLSX) 열기: 형식 확인 · 보안 문서 거르기 · 안에 든 사진 목록
   ------------------------------------------------------------
   워커 전용, UI 없음. 사전 확인(probe.js)과 처리 엔진(compress.js)이 같이 쓴다.
   글자·표·서식·구조는 읽지도 바꾸지도 않는다. 사진이 든 자리만 찾는다.
     HWPX            : ZIP, BinData/
     DOCX·PPTX·XLSX  : ZIP, word/media/ · ppt/media/ · xl/media/
     HWP 5.0         : 복합 파일, BinData 스토리지 (압축 플래그면 raw deflate)
   처리하지 않는 문서(암호·배포용·DRM·전자 서명)는 notice 오류로 안내만 한다.
   ============================================================ */

import { readZip, entryData } from './zip.js';
import { isCfb, readCfb, findEntry } from './cfb.js';

const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
let fflateP = null;
export function loadFflate() {
  if (!fflateP) { fflateP = import(FFLATE_URL); fflateP.catch(() => { fflateP = null; }); }
  return fflateP;
}

export const DOC_EXTS = ['hwp', 'hwpx', 'docx', 'pptx', 'xlsx'];
const MEDIA_DIR = { hwpx: 'BinData/', docx: 'word/media/', pptx: 'ppt/media/', xlsx: 'xl/media/' };
const PHOTO_EXT = /\.(jpe?g|png|gif|bmp|tiff?|webp|wdp|jxr)$/i;
const NAME = { hwp: '한글', hwpx: '한글', docx: '워드', pptx: '파워포인트', xlsx: '엑셀' };

const notice = (msg) => Object.assign(new Error(msg), { notice: true });
const unsupported = (msg) => Object.assign(new Error(msg), { unsupported: true });
export const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; };

/** JPG·PNG 인지 (같은 형식으로 다시 압축할 수 있는 사진) */
export function photoType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  return null;
}

/**
 * 문서를 연다.
 * @returns {{ ext, container:'zip'|'cfb', images: Array<{ key, name, size, ext }>, read(key) → Uint8Array, ... }}
 *   images 는 사진으로 보이는 항목(이름 기준, 벡터 그림 EMF·WMF·SVG 제외). 실제로 줄일지는 내용으로 다시 판단.
 */
export async function openDoc(u8, fileName) {
  const ext = extOf(fileName);
  if (!DOC_EXTS.includes(ext)) throw unsupported('지원하지 않는 문서 형식입니다');
  const fflate = await loadFflate();
  const zipSig = u8[0] === 0x50 && u8[1] === 0x4b;

  if (ext === 'hwp') {
    if (!isCfb(u8)) {
      const head = String.fromCharCode(...u8.subarray(0, 32));
      if (head.startsWith('HWP Document File')) throw notice('한글 97 이전 형식(HWP 3.0)은 지원하지 않습니다. 한글에서 다시 저장한 뒤 올려 주세요.');
      throw unsupported('한글(HWP) 파일이 아니거나 손상된 파일입니다');
    }
    return openHwp(u8, fflate);
  }
  if (isCfb(u8)) {
    // 암호를 건 워드·파워포인트·엑셀은 ZIP 이 아니라 복합 파일(EncryptedPackage) 안에 들어 있다
    const c = readCfb(u8);
    const names = c.entries.map((e) => e.name);
    if (names.includes('EncryptedPackage') || names.includes('EncryptionInfo')) throw notice(`암호가 걸린 ${NAME[ext]} 문서는 처리할 수 없습니다. 암호를 해제한 뒤 다시 올려 주세요.`);
    if (names.some((n) => n.includes('DataSpaces'))) throw notice(`보안(DRM)이 적용된 ${NAME[ext]} 문서는 처리할 수 없습니다.`);
    throw unsupported(`${ext.toUpperCase()} 형식이 아닌 파일입니다 (예전 .doc·.ppt·.xls 형식일 수 있어요)`);
  }
  if (!zipSig) throw unsupported(`${ext.toUpperCase()} 파일이 아니거나 손상된 파일입니다`);
  return openZipDoc(u8, ext, fflate);
}

function openZipDoc(u8, ext, fflate) {
  const zip = readZip(u8);
  const names = zip.entries.map((e) => e.name);
  if (zip.entries.some((e) => e.flags & 1)) throw notice(`암호가 걸린 ${NAME[ext]} 문서는 처리할 수 없습니다. 암호를 해제한 뒤 다시 올려 주세요.`);
  // 전자 서명: 내용을 바꾸면 서명이 깨지므로 처리하지 않는다
  if (names.some((n) => /^_xmlsignatures\//i.test(n) || /^META-INF\/signatures/i.test(n))) {
    throw notice(`전자 서명된 ${NAME[ext]} 문서는 사진을 바꾸면 서명이 무효가 되어 처리하지 않습니다.`);
  }
  if (ext === 'hwpx') {
    const man = zip.entries.find((e) => e.name === 'META-INF/manifest.xml');
    if (man) {
      const xml = new TextDecoder().decode(entryData(u8, man, fflate));
      if (/encryption-data|EncryptedData|encrypt/i.test(xml)) throw notice('암호가 걸린 한글 문서는 처리할 수 없습니다. 암호를 해제한 뒤 다시 올려 주세요.');
    }
    if (!names.includes('mimetype') && !names.some((n) => /^Contents\//.test(n))) throw unsupported('한글(HWPX) 파일이 아니거나 손상된 파일입니다');
  } else if (!names.includes('[Content_Types].xml')) {
    throw unsupported(`${ext.toUpperCase()} 파일이 아니거나 손상된 파일입니다`);
  }
  const dir = MEDIA_DIR[ext];
  const images = zip.entries
    .filter((e) => e.name.startsWith(dir) && !e.name.endsWith('/') && PHOTO_EXT.test(e.name))
    .map((e) => ({ key: e.name, name: e.name.slice(dir.length), size: e.usize, ext: extOf(e.name) }));
  return {
    ext, container: 'zip', zip, fflate, images,
    read: (key) => entryData(u8, zip.entries.find((e) => e.name === key), fflate),
  };
}

/* HWP 5.0: FileHeader 속성 비트
   0 압축 · 1 암호 · 2 배포용 · 3 스크립트 · 4 DRM · 5 XML 템플릿 · 6 문서 이력 · 7 전자 서명
   8 공인인증서 암호화 · 9 전자 서명 예비 · 10 공인인증서 DRM · 11 CCL */
function openHwp(u8, fflate) {
  const cfb = readCfb(u8);
  const fh = findEntry(cfb, 'FileHeader');
  if (!fh) throw unsupported('한글(HWP) 파일이 아니거나 손상된 파일입니다');
  const h = cfb.data(fh.index);
  const sig = String.fromCharCode(...h.subarray(0, 17));
  if (sig !== 'HWP Document File' || h.length < 40) throw unsupported('한글(HWP) 파일이 아니거나 손상된 파일입니다');
  const props = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(36, true);
  if (props & (1 << 1)) throw notice('암호가 걸린 한글 문서는 처리할 수 없습니다. 한글에서 암호를 해제한 뒤 다시 올려 주세요.');
  if (props & (1 << 2)) throw notice('배포용 한글 문서는 내용을 바꿀 수 없게 보호되어 있어 처리하지 않습니다.');
  if (props & ((1 << 4) | (1 << 10))) throw notice('보안(DRM)이 적용된 한글 문서는 처리할 수 없습니다.');
  if (props & (1 << 8)) throw notice('공인인증서로 암호화된 한글 문서는 처리할 수 없습니다.');
  if (props & (1 << 7)) throw notice('전자 서명된 한글 문서는 사진을 바꾸면 서명이 무효가 되어 처리하지 않습니다.');
  const images = cfb.entries
    .filter((e) => e.type === 2 && e.path && e.path.startsWith('BinData/') && PHOTO_EXT.test(e.name))
    .map((e) => ({ key: e.index, name: e.name, size: e.size, ext: extOf(e.name) }));
  return {
    ext: 'hwp', container: 'cfb', cfb, fflate, images, compressed: !!(props & 1),
    // 그림 스트림: 압축(raw deflate)이면 풀어서. 풀어 보고 사진이 아니면 원래 바이트를 사진으로 본다.
    readHwp: (key) => {
      const raw = cfb.data(key);
      try {
        const inflated = fflate.inflateSync(raw);
        if (photoType(inflated)) return { data: inflated, deflated: true };
      } catch { /* 압축 안 된 스트림 */ }
      return { data: raw, deflated: false };
    },
  };
}
