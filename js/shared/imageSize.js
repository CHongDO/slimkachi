/* ============================================================
   imageSize.js — 사진의 가로·세로를 파일 헤더만 읽어 알아낸다 (화면 쪽, 디코딩 없음)
   ------------------------------------------------------------
   업로드 직후 위험 계수 계산용. 파일 앞부분(필요하면 몇 조각 더)만 읽는다.
     JPEG  SOF 세그먼트 (EXIF 가 길어도 세그먼트를 건너뛰며 찾음)
     PNG   IHDR · WebP VP8/VP8L/VP8X · GIF 화면 크기 · BMP DIB 헤더 · ICO 항목 중 가장 큰 것
     AVIF·HEIC  'ispe' 상자 중 가장 큰 것 (격자 사진은 전체 크기 상자가 가장 큼)
     TIFF  IFD 의 256/257 태그 (여러 IFD 중 가장 큰 것)
   모르는 형식이나 헤더가 이상하면 null → 호출하는 쪽이 파일 용량으로 어림한다.
   파일은 브라우저 메모리 안에서만 읽으며 어디로도 전송되지 않습니다.
   ============================================================ */

const CHUNK = 64 * 1024;
const MAX_SIDE = 1 << 20;   // 이보다 큰 값은 헤더 손상으로 본다

const read = async (file, start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());
const ascii = (u8, i, n) => String.fromCharCode(...u8.subarray(i, i + n));
const be16 = (u, i) => (u[i] << 8) | u[i + 1];
const be32 = (u, i) => ((u[i] << 24) | (u[i + 1] << 16) | (u[i + 2] << 8) | u[i + 3]) >>> 0;
const le16 = (u, i) => u[i] | (u[i + 1] << 8);
const le24 = (u, i) => u[i] | (u[i + 1] << 8) | (u[i + 2] << 16);
const le32 = (u, i) => (u[i] | (u[i + 1] << 8) | (u[i + 2] << 16) | (u[i + 3] << 24)) >>> 0;
const ok = (w, h) => (w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE ? { width: w, height: h } : null);

/** @returns {Promise<{width:number,height:number}|null>} */
export async function imageDims(file) {
  try {
    const u = await read(file, 0, CHUNK);
    if (u.length < 16) return null;
    if (u[0] === 0xff && u[1] === 0xd8) return await jpeg(file, u);
    if (u[0] === 0x89 && ascii(u, 1, 3) === 'PNG') return ok(be32(u, 16), be32(u, 20));
    if (ascii(u, 0, 4) === 'RIFF' && ascii(u, 8, 4) === 'WEBP') return webp(u);
    if (ascii(u, 0, 4) === 'GIF8') return ok(le16(u, 6), le16(u, 8));
    if (u[0] === 0x42 && u[1] === 0x4d) return bmp(u);
    if (u[0] === 0 && u[1] === 0 && (u[2] === 1 || u[2] === 2) && u[3] === 0) return ico(u);
    if (ascii(u, 4, 4) === 'ftyp') return ispe(u);
    if ((u[0] === 0x49 && u[1] === 0x49 && u[2] === 42) || (u[0] === 0x4d && u[1] === 0x4d && u[3] === 42)) return await tiff(file, u);
  } catch { /* 헤더가 이상하면 어림값으로 */ }
  return null;
}

/* JPEG: 세그먼트를 건너뛰며 SOF(C0~CF, C4·C8·CC 제외)를 찾는다. 앞 64KB 를 넘어가면 그 자리부터 더 읽는다. */
async function jpeg(file, head) {
  let buf = head, base = 0;
  const at = async (i) => {
    if (i < base || i >= base + buf.length) { base = i; buf = await read(file, i, CHUNK); }
    return i - base < buf.length ? buf[i - base] : -1;
  };
  let pos = 2;
  for (let n = 0; n < 500 && pos < file.size; n++) {
    if (await at(pos) !== 0xff) return null;
    let m = await at(pos + 1);
    while (m === 0xff) { pos++; m = await at(pos + 1); }   // 채움 바이트
    if (m < 0) return null;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;               // SOF 전에 끝/본문이면 실패
    const len = ((await at(pos + 2)) << 8) | (await at(pos + 3));
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = ((await at(pos + 5)) << 8) | (await at(pos + 6));
      const w = ((await at(pos + 7)) << 8) | (await at(pos + 8));
      return ok(w, h);
    }
    if (len < 2) return null;
    pos += 2 + len;
  }
  return null;
}

function webp(u) {
  const kind = ascii(u, 12, 4);
  if (kind === 'VP8 ' && u[23] === 0x9d && u[24] === 0x01 && u[25] === 0x2a) return ok(le16(u, 26) & 0x3fff, le16(u, 28) & 0x3fff);
  if (kind === 'VP8L' && u[20] === 0x2f) {
    const b = le32(u, 21);
    return ok((b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1);
  }
  if (kind === 'VP8X') return ok(le24(u, 24) + 1, le24(u, 27) + 1);
  return null;
}

function bmp(u) {
  const dib = le32(u, 14);
  if (dib === 12) return ok(le16(u, 18), le16(u, 20));
  const w = le32(u, 18) | 0, h = le32(u, 22) | 0;
  return ok(Math.abs(w), Math.abs(h));
}

function ico(u) {
  const n = le16(u, 4);
  let best = null;
  for (let i = 0; i < n && 6 + 16 * i + 2 <= u.length; i++) {
    const w = u[6 + 16 * i] || 256, h = u[7 + 16 * i] || 256;
    if (!best || w * h > best.width * best.height) best = { width: w, height: h };
  }
  return best;
}

/* AVIF·HEIC: 'ispe'(사진 크기) 상자 = [크기 4][ispe][버전·플래그 4][가로 4][세로 4] */
function ispe(u) {
  let best = null;
  for (let i = 4; i + 16 <= u.length; i++) {
    if (u[i] !== 0x69 || u[i + 1] !== 0x73 || u[i + 2] !== 0x70 || u[i + 3] !== 0x65) continue;   // 'ispe'
    const d = ok(be32(u, i + 8), be32(u, i + 12));
    if (d && (!best || d.width * d.height > best.width * best.height)) best = d;
  }
  return best;
}

/* TIFF: IFD 사슬을 따라가며 ImageWidth(256)·ImageLength(257) 중 가장 큰 사진 */
async function tiff(file, head) {
  const le = head[0] === 0x49;
  const g16 = (u, i) => (le ? le16(u, i) : be16(u, i));
  const g32 = (u, i) => (le ? le32(u, i) : be32(u, i));
  let off = g32(head, 4), best = null;
  for (let k = 0; k < 8 && off > 0 && off < file.size; k++) {
    const cnt = g16(await read(file, off, 2), 0);
    if (!cnt || cnt > 4096) break;
    const ifd = await read(file, off + 2, cnt * 12 + 4);
    let w = 0, h = 0;
    for (let e = 0; e < cnt; e++) {
      const p = e * 12, tag = g16(ifd, p), type = g16(ifd, p + 2);
      const val = type === 3 ? g16(ifd, p + 8) : g32(ifd, p + 8);
      if (tag === 256) w = val;
      if (tag === 257) h = val;
    }
    const d = ok(w, h);
    if (d && (!best || d.width * d.height > best.width * best.height)) best = d;
    off = g32(ifd, cnt * 12);
  }
  return best;
}
