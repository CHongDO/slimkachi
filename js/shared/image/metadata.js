/* ============================================================
   metadata.js — 형식 판별 + 무손실 메타데이터 제거
   ------------------------------------------------------------
   픽셀 데이터는 그대로 두고 EXIF·XMP·주석·썸네일 등만 잘라냅니다.
   색에 영향을 주는 정보(ICC 프로필, 감마 등)와 회전 정보는 유지해
   화면에 보이는 모습이 바뀌지 않게 합니다.
   ============================================================ */

export const MIME = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic', tiff: 'image/tiff',
};
export const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };

// 저장 형식 규칙은 화면과 같이 쓰므로 js/shared/formats.js 에 있다
export { SAVEABLE, OUTPUTS, autoFormat, outputFormat } from '../formats.js';

function ascii(u8, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * 파일 앞부분(매직 바이트)으로 형식을 알아본다. 모르면 null — 그래도 브라우저가 열 수 있으면 사진으로 처리한다.
 * 'svg' · 'psd' 는 알아보기만 하고 처리하지 않는다(이번 범위 밖 / 브라우저가 못 읽음).
 */
export function detectType(u8) {
  if (u8.length < 12) return null;
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg';
  if (u8[0] === 0x89 && ascii(u8, 1, 3) === 'PNG') return 'png';
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return 'webp';
  if (ascii(u8, 0, 4) === 'GIF8') return 'gif';
  if (u8[0] === 0x42 && u8[1] === 0x4d) return 'bmp';
  if (u8[0] === 0 && u8[1] === 0 && (u8[2] === 1 || u8[2] === 2) && u8[3] === 0 && u8[4] + u8[5] > 0) return 'ico';
  if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42 && u8[3] === 0)
    || (u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0 && u8[3] === 42)) return 'tiff';
  if (ascii(u8, 4, 4) === 'ftyp') {
    // ISO BMFF: 주 브랜드 + 호환 브랜드에 avif 가 있으면 AVIF, HEIF 계열이면 HEIC
    const size = Math.min(u8.length, ((u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3]) >>> 0, 256);
    const brands = [ascii(u8, 8, 4)];
    for (let p = 16; p + 4 <= size; p += 4) brands.push(ascii(u8, p, 4));
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
    if (brands.some((b) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(b))) return 'heic';
    return null;
  }
  if (ascii(u8, 0, 4) === '8BPS') return 'psd';
  const head = ascii(u8, 0, Math.min(u8.length, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

/** GIF 안의 그림(프레임)이 둘 이상인지 — 블록 구조를 따라가며 센다 */
function gifAnimated(u8) {
  let p = 13;
  if (u8[10] & 0x80) p += 3 * (1 << ((u8[10] & 7) + 1));     // 전역 색 표
  const skipSub = () => { while (p < u8.length && u8[p]) p += u8[p] + 1; p++; };
  let frames = 0;
  while (p < u8.length) {
    const b = u8[p];
    if (b === 0x21) { p += 2; skipSub(); }                    // 확장 블록
    else if (b === 0x2c) {                                    // 그림
      if (++frames > 1) return true;
      const packed = u8[p + 9];
      p += 10;
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));  // 지역 색 표
      p++;                                                    // LZW 최소 코드 길이
      skipSub();
    } else break;                                             // 0x3B(끝) 또는 손상
  }
  return false;
}

/** 움직이는 이미지인지 (GIF 여러 프레임, APNG, 애니메이션 WebP) */
export function isAnimated(type, u8) {
  try {
    if (type === 'gif') return gifAnimated(u8);
    if (type === 'png' || type === 'webp') return stripMetadata(type, u8).animated;
  } catch { /* 손상된 파일은 움직이지 않는 것으로 */ }
  return false;
}

/** TIFF 블록(EXIF 본문)에서 Orientation(0x0112) 값을 읽는다. 없으면 1. */
function readOrientation(u8, start, end) {
  try {
    const dv = new DataView(u8.buffer, u8.byteOffset + start, end - start);
    const order = dv.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) return 1;
    const le = order === 0x4949;
    if (dv.getUint16(2, le) !== 42) return 1;
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      if (dv.getUint16(e, le) === 0x0112) {
        const v = dv.getUint16(e + 8, le);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch { /* 손상된 EXIF는 무시 */ }
  return 1;
}

/** 회전 정보 하나만 담은 최소 EXIF APP1 세그먼트 (34바이트) */
function minimalExifApp1(orientation) {
  const seg = new Uint8Array(36);
  const dv = new DataView(seg.buffer);
  dv.setUint16(0, 0xffe1);
  dv.setUint16(2, 34);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  dv.setUint16(10, 0x4d4d);                    // MM (big endian)
  dv.setUint16(12, 42);
  dv.setUint32(14, 8);                         // IFD0 offset
  dv.setUint16(18, 1);                         // entry count
  dv.setUint16(20, 0x0112);                    // Orientation
  dv.setUint16(22, 3);                         // SHORT
  dv.setUint32(24, 1);
  dv.setUint16(28, orientation);
  dv.setUint32(32, 0);                         // next IFD
  return seg;
}

/* ---------- JPEG ---------- */
function stripJpeg(u8) {
  const parts = [u8.subarray(0, 2)];
  let p = 2;
  let orientation = 1;
  let afterApp0 = 1; // 최소 EXIF를 끼워 넣을 위치(parts 인덱스)
  const len = u8.length;

  while (p + 4 <= len) {
    if (u8[p] !== 0xff) return null; // 구조가 예상과 다르면 손대지 않음
    const marker = u8[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xda) {
      // SOS 이후는 영상 데이터. 첫 EOI 까지만 담아 뒤에 붙은 부가 이미지(MPF 등)를 제거.
      let q = p + 2;
      let end = len;
      while (q + 1 < len) {
        if (u8[q] === 0xff) {
          const m = u8[q + 1];
          if (m === 0xd9) { end = q + 2; break; }
          if (m === 0xff) { q += 1; continue; }
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { q += 2; continue; }
          // 프로그레시브 JPEG의 DHT/SOS 등 중간 세그먼트는 길이만큼 건너뜀
          if (q + 3 >= len) break;
          q += 2 + ((u8[q + 2] << 8) | u8[q + 3]);
          continue;
        }
        q++;
      }
      parts.push(u8.subarray(p, end));
      break;
    }
    if (marker === 0xd9) { parts.push(u8.subarray(p, p + 2)); break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(u8.subarray(p, p + 2)); p += 2; continue; }

    const segLen = (u8[p + 2] << 8) | u8[p + 3];
    const segEnd = p + 2 + segLen;
    if (segLen < 2 || segEnd > len) return null;

    let keep = true;
    if (marker === 0xe1) {
      if (ascii(u8, p + 4, 6) === 'Exif\0\0') orientation = readOrientation(u8, p + 10, segEnd);
      keep = false; // EXIF / XMP
    } else if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe0 && ascii(u8, p + 4, 5) === 'JFIF\0') { keep = true; afterApp0 = parts.length + 1; }
      else if (marker === 0xe2 && ascii(u8, p + 4, 12) === 'ICC_PROFILE\0') keep = true; // 색 정보
      else if (marker === 0xee && ascii(u8, p + 4, 5) === 'Adobe') keep = true;          // 색 변환 정보
      else keep = false;
    } else if (marker === 0xfe) {
      keep = false; // 주석
    }
    if (keep) parts.push(u8.subarray(p, segEnd));
    p = segEnd;
  }

  if (orientation !== 1) parts.splice(afterApp0, 0, minimalExifApp1(orientation));
  return { bytes: concat(parts), orientation, animated: false };
}

/* ---------- PNG ---------- */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB',
  'cICP', 'mDCv', 'cLLi', 'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT',
]);

function stripPng(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const parts = [u8.subarray(0, 8)];
  let p = 8;
  let animated = false;
  let orientation = 1;
  while (p + 12 <= u8.length) {
    const len = dv.getUint32(p);
    const type = ascii(u8, p + 4, 4);
    const end = p + 12 + len;
    if (end > u8.length) return null;
    let keep = PNG_KEEP.has(type);
    if (type === 'acTL') animated = true;
    if (type === 'eXIf') {
      orientation = readOrientation(u8, p + 8, p + 8 + len);
      keep = orientation !== 1; // 회전 정보가 있으면 보이는 모습 유지를 위해 남김
    }
    if (keep) parts.push(u8.subarray(p, end));
    p = end;
    if (type === 'IEND') break;
  }
  return { bytes: concat(parts), orientation, animated };
}

/* ---------- WebP ---------- */
function stripWebp(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const chunks = [];
  let p = 12;
  let animated = false;
  let orientation = 1;
  while (p + 8 <= u8.length) {
    const fourcc = ascii(u8, p, 4);
    const size = dv.getUint32(p + 4, true);
    const end = p + 8 + size + (size & 1);
    if (p + 8 + size > u8.length) return null;
    if (fourcc === 'ANIM') animated = true;
    if (fourcc === 'EXIF') {
      let s = p + 8;
      if (ascii(u8, s, 6) === 'Exif\0\0') s += 6;
      orientation = readOrientation(u8, s, p + 8 + size);
    }
    chunks.push({ fourcc, start: p, end: Math.min(end, u8.length) });
    p = end;
  }
  const keepExif = orientation !== 1;
  const kept = chunks.filter((c) => {
    if (c.fourcc === 'XMP ') return false;
    if (c.fourcc === 'EXIF') return keepExif;
    return true;
  });
  const parts = [new Uint8Array(12)];
  for (const c of kept) {
    const piece = u8.slice(c.start, c.end);
    if (c.fourcc === 'VP8X') {
      piece[8] &= ~0x04;                 // XMP 플래그 해제
      if (!keepExif) piece[8] &= ~0x08;  // EXIF 플래그 해제
    }
    parts.push(piece);
  }
  const out = concat(parts);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  return { bytes: out, orientation, animated };
}

/**
 * 메타데이터를 무손실로 제거한다.
 * @returns {{bytes: Uint8Array|null, orientation: number, animated: boolean}}
 *   bytes 는 원본보다 작아졌을 때만 채워진다.
 */
export function stripMetadata(type, u8) {
  let r = null;
  try {
    if (type === 'jpeg') r = stripJpeg(u8);
    else if (type === 'png') r = stripPng(u8);
    else if (type === 'webp') r = stripWebp(u8);
  } catch { r = null; }
  if (!r) return { bytes: null, orientation: 1, animated: false };
  if (r.bytes.length >= u8.length) r.bytes = null;
  return r;
}
