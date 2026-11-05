/* ============================================================
   zip.js — ZIP 문서(HWPX·DOCX·PPTX·XLSX) 읽기 + "바꾼 항목만" 다시 쓰기 (워커 전용, UI 없음)
   ------------------------------------------------------------
   바뀌지 않은 항목은 압축된 바이트(로컬 헤더·데이터·데이터 설명자)를 그대로 복사한다.
   그래서 항목 이름·순서·시간·추가 필드·압축 방식이 원본과 같다. 바꾼 항목만 새 로컬 헤더 + 데이터로 쓰고,
   중앙 디렉터리는 원본 레코드를 복사해 오프셋·CRC·크기만 고친다.
   압축 풀기·하기는 fflate(MIT)의 raw inflate/deflate 를 쓴다(호출하는 쪽이 넘겨 줌).
   ZIP64·암호화 ZIP 은 다루지 않는다(오류).
   ============================================================ */

import { t as tx } from '../../i18n/index.js';

const SIG_LOCAL = 0x04034b50, SIG_CD = 0x02014b50, SIG_EOCD = 0x06054b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextDecoder('utf-8');
const latin = (b) => String.fromCharCode(...b);

/** @returns {{ entries: Array, cdOffset:number, cdSize:number, eocdOffset:number }} */
export function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(tx('zip.001'));
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw Object.assign(new Error(tx('zip.002')), { notice: true });
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== SIG_CD) throw new Error(tx('zip.003'));
    const flags = dv.getUint16(p + 8, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
    const recLen = 46 + nameLen + extraLen + commentLen;
    entries.push({
      index: i,
      name: flags & 0x800 ? utf8.decode(nameBytes) : latin(nameBytes),
      flags,
      method: dv.getUint16(p + 10, true),
      crc: dv.getUint32(p + 16, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      lho: dv.getUint32(p + 42, true),
      cdPos: p, cdLen: recLen,
    });
    p += recLen;
  }
  return { entries, cdOffset, cdSize, eocdOffset: eocd };
}

/** 항목의 압축된 데이터 위치 */
function dataRange(u8, e) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(e.lho, true) !== SIG_LOCAL) throw new Error(tx('zip.004', { name: e.name }));
  const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
  return [start, start + e.csize];
}

/** 항목 내용(압축 해제) */
export function entryData(u8, e, fflate) {
  if (e.flags & 1) throw Object.assign(new Error(tx('zip.005')), { notice: true });
  const [a, b] = dataRange(u8, e);
  const raw = u8.subarray(a, b);
  if (e.method === 0) return raw.slice();
  if (e.method === 8) return fflate.inflateSync(raw, { out: new Uint8Array(e.usize) });
  throw new Error(tx('zip.006', { method: e.method, name: e.name }));
}

/**
 * 바꾼 항목만 새로 쓴 ZIP.
 * @param repl  Map<항목 이름, 새 내용(압축 전)>
 * @param opts.store  압축하지 않고(STORE) 다시 쓸 항목 이름들 (예: HWPX 의 mimetype)
 */
export function patchZip(u8, zip, repl, fflate, { store = [] } = {}) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const byOffset = [...zip.entries].sort((a, b) => a.lho - b.lho);
  const parts = [];
  let size = 0;
  const push = (b) => { parts.push(b); size += b.length; };
  const fresh = new Map();   // 항목 → { offset, crc, csize, usize, method, flags }

  // 첫 항목 앞에 붙은 데이터(있다면)는 그대로
  if (byOffset.length && byOffset[0].lho > 0) push(u8.subarray(0, byOffset[0].lho));
  byOffset.forEach((e, k) => {
    const end = k + 1 < byOffset.length ? byOffset[k + 1].lho : zip.cdOffset;
    const forceStore = store.includes(e.name) && e.method !== 0;
    if (!repl.has(e.name) && !forceStore) {
      fresh.set(e, { offset: size });
      push(u8.subarray(e.lho, end));   // 로컬 헤더 + 데이터 + 데이터 설명자 그대로
      return;
    }
    const content = repl.has(e.name) ? repl.get(e.name) : entryData(u8, e, fflate);
    const method = store.includes(e.name) ? 0 : e.method;
    const data = method === 8 ? fflate.deflateSync(content, { level: 9 }) : content;
    const crc = crc32(content);
    const nameLen = dv.getUint16(e.lho + 26, true), extraLen = dv.getUint16(e.lho + 28, true);
    const head = u8.slice(e.lho, e.lho + 30 + nameLen + extraLen);   // 이름·추가 필드·시간은 원본 그대로
    const hv = new DataView(head.buffer);
    const flags = e.flags & ~0x08;                                   // 크기를 헤더에 적으므로 데이터 설명자 없음
    hv.setUint16(6, flags, true);
    hv.setUint16(8, method, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, data.length, true);
    hv.setUint32(22, content.length, true);
    fresh.set(e, { offset: size, crc, csize: data.length, usize: content.length, method, flags });
    push(head);
    push(data);
  });

  // 중앙 디렉터리: 원본 레코드 복사 + 오프셋·바뀐 값만 고침
  const cdStart = size;
  for (const e of zip.entries) {
    const rec = u8.slice(e.cdPos, e.cdPos + e.cdLen);
    const rv = new DataView(rec.buffer);
    const f = fresh.get(e);
    rv.setUint32(42, f.offset, true);
    if (f.crc !== undefined) {
      rv.setUint16(8, f.flags, true);
      rv.setUint16(10, f.method, true);
      rv.setUint32(16, f.crc, true);
      rv.setUint32(20, f.csize, true);
      rv.setUint32(24, f.usize, true);
    }
    push(rec);
  }
  const cdSize = size - cdStart;
  const eocd = u8.slice(zip.eocdOffset);   // 주석 포함
  const ev = new DataView(eocd.buffer);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  push(eocd);

  const out = new Uint8Array(size);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}
