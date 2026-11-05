/* ============================================================
   cfb.js — 복합 파일(CFB / OLE2, 한글 HWP 5.0 의 그릇) 읽기·다시 쓰기 (워커 전용, UI 없음)
   ------------------------------------------------------------
   읽기: 헤더 → DIFAT → FAT → 디렉터리 → 미니 FAT·미니 스트림.
   쓰기: 디렉터리 항목(128바이트)은 원본을 그대로 복사하고 시작 섹터·크기만 고친다.
         그래서 스트림·스토리지 이름, 트리 연결(왼쪽·오른쪽·자식), 색, CLSID, 시간이 모두 원본과 같다.
         데이터는 새로 배치한다: [일반 스트림][미니 스트림 그릇][디렉터리][미니 FAT][FAT][DIFAT].
         4096바이트 미만 스트림은 미니 스트림에(규격), 섹터 크기·버전(3/4)은 원본을 따른다.
   외부 라이브러리 없이 직접 구현 (범용 라이브러리는 쓸 때 임시 스트림을 덧붙이는 경우가 있어서).
   ============================================================ */

import { t as tx } from '../../i18n/index.js';

const FREE = 0xffffffff, END = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc, NOSTREAM = 0xffffffff;
const MAXREG = 0xfffffffa;
const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export const isCfb = (u8) => u8.length >= 512 && SIG.every((b, i) => u8[i] === b);

export function readCfb(u8) {
  if (!isCfb(u8)) throw new Error(tx('cfb.001'));
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const major = dv.getUint16(26, true);
  const S = 1 << dv.getUint16(30, true);
  const MS = 1 << dv.getUint16(32, true);
  if ((S !== 512 && S !== 4096) || MS !== 64) throw new Error(tx('cfb.002'));
  const nFat = dv.getUint32(44, true);
  const dirStart = dv.getUint32(48, true);
  const cutoff = dv.getUint32(56, true) || 4096;
  const miniFatStart = dv.getUint32(60, true);
  let difat = dv.getUint32(68, true);
  const per = S / 4;
  const nSect = Math.floor((u8.length - S) / S) + (u8.length % S ? 1 : 0);
  const sectorAt = (n) => {
    const a = (n + 1) * S;
    if (n >= MAXREG || a >= u8.length) throw new Error(tx('cfb.003'));
    return u8.subarray(a, Math.min(a + S, u8.length));
  };

  // DIFAT → FAT 섹터 번호들
  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const v = dv.getUint32(76 + i * 4, true);
    if (v < MAXREG) fatSecs.push(v);
  }
  for (let guard = 0; difat < MAXREG && fatSecs.length < nFat && guard < nSect; guard++) {
    const s = sectorAt(difat), sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < per - 1 && fatSecs.length < nFat; i++) {
      const v = sv.getUint32(i * 4, true);
      if (v < MAXREG) fatSecs.push(v);
    }
    difat = sv.getUint32(S - 4, true);
  }
  const fat = new Uint32Array(fatSecs.length * per).fill(FREE);
  fatSecs.forEach((n, k) => {
    const s = sectorAt(n);
    const v = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < Math.floor(s.length / 4); i++) fat[k * per + i] = v.getUint32(i * 4, true);
  });

  const chain = (start, table, limit) => {
    const out = [];
    const seen = new Set();
    for (let n = start; n < MAXREG; n = table[n]) {
      if (seen.has(n) || n >= table.length || out.length > limit) throw new Error(tx('cfb.004'));
      seen.add(n);
      out.push(n);
    }
    return out;
  };
  const readRegular = (start, size) => {
    const out = new Uint8Array(size);
    let o = 0;
    for (const n of chain(start, fat, nSect)) {
      if (o >= size) break;
      const s = sectorAt(n);
      const take = Math.min(s.length, size - o);
      out.set(s.subarray(0, take), o);
      o += take;
    }
    if (o < size) throw new Error(tx('cfb.005'));
    return out;
  };

  // 디렉터리
  const dirSecs = chain(dirStart, fat, nSect);
  const dirBytes = new Uint8Array(dirSecs.length * S);
  dirSecs.forEach((n, k) => dirBytes.set(sectorAt(n), k * S));
  const dd = new DataView(dirBytes.buffer);
  const entries = [];
  for (let i = 0; i * 128 < dirBytes.length; i++) {
    const o = i * 128;
    const nameLen = Math.min(64, dd.getUint16(o + 64, true));
    let name = '';
    for (let k = 0; k + 1 < nameLen - 1; k += 2) name += String.fromCharCode(dd.getUint16(o + k, true));
    const lo = dd.getUint32(o + 120, true), hi = dd.getUint32(o + 124, true);
    entries.push({
      index: i, name,
      type: dd.getUint8(o + 66),
      left: dd.getUint32(o + 68, true), right: dd.getUint32(o + 72, true), child: dd.getUint32(o + 76, true),
      start: dd.getUint32(o + 116, true),
      size: major === 3 ? lo : lo + hi * 2 ** 32,
      raw: dirBytes.slice(o, o + 128),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new Error(tx('cfb.006'));

  // 미니 FAT · 미니 스트림
  let miniFat = new Uint32Array(0);
  if (miniFatStart < MAXREG) {
    const secs = chain(miniFatStart, fat, nSect);
    const b = new Uint8Array(secs.length * S);
    secs.forEach((n, k) => b.set(sectorAt(n), k * S));
    miniFat = new Uint32Array(b.buffer, 0, b.length / 4);
  }
  const ministream = root.size > 0 && root.start < MAXREG ? readRegular(root.start, root.size) : new Uint8Array(0);

  const data = (i) => {
    const e = entries[i];
    if (!e || e.type !== 2) return null;
    if (e.size === 0) return new Uint8Array(0);
    if (e.size >= cutoff) return readRegular(e.start, e.size);
    const out = new Uint8Array(e.size);
    let o = 0;
    for (const n of chain(e.start, miniFat, ministream.length / MS + 1)) {
      if (o >= e.size) break;
      const a = n * MS;
      if (a + Math.min(MS, e.size - o) > ministream.length) throw new Error(tx('cfb.007'));
      const take = Math.min(MS, e.size - o);
      out.set(ministream.subarray(a, a + take), o);
      o += take;
    }
    return out;
  };

  // 경로 붙이기 ('BinData/BIN0001.jpg' 처럼). 트리를 따라가며, 고리가 있으면 멈춘다.
  const seen = new Set();
  const walk = (idx, prefix) => {
    if (idx === NOSTREAM || idx >= entries.length || seen.has(idx)) return;
    seen.add(idx);
    const e = entries[idx];
    walk(e.left, prefix);
    e.path = prefix + e.name;
    if (e.type === 1) walk(e.child, `${e.path}/`);
    walk(e.right, prefix);
  };
  walk(root.child, '');
  root.path = '';

  return { header: u8.slice(0, 512), major, S, MS, cutoff, entries, data };
}

/** 경로로 항목 찾기 */
export const findEntry = (cfb, path) => cfb.entries.find((e) => e.path === path) || null;

/**
 * 다시 쓰기. repl: Map<항목 번호, 새 내용>. 나머지 스트림은 원본 내용 그대로.
 */
export function writeCfb(cfb, repl) {
  const { S, MS, cutoff, entries, major } = cfb;
  const per = S / 4;
  const datas = entries.map((e, i) => (e.type === 2 ? (repl.get(i) || cfb.data(i)) : null));
  const ceil = (a, b) => Math.ceil(a / b);

  // 배치 계산
  const miniStart = new Map(), regStart = new Map();
  let miniCount = 0;
  datas.forEach((d, i) => {
    if (d && d.length > 0 && d.length < cutoff) { miniStart.set(i, miniCount); miniCount += ceil(d.length, MS); }
  });
  let sec = 0;
  datas.forEach((d, i) => {
    if (d && d.length >= cutoff) { regStart.set(i, sec); sec += ceil(d.length, S); }
  });
  const miniSecs = ceil(miniCount * MS, S);
  const rootStart = miniSecs ? sec : END;
  sec += miniSecs;
  const dirSecs = ceil(entries.length * 128, S);
  const dirStart = sec;
  sec += dirSecs;
  const miniFatSecs = ceil(miniCount * 4, S);
  const miniFatStart = miniFatSecs ? sec : END;
  sec += miniFatSecs;
  let nFat = 0, nDifat = 0;
  for (;;) {
    const needFat = ceil(sec + nFat + nDifat, per);
    const needDifat = needFat > 109 ? ceil(needFat - 109, per - 1) : 0;
    if (needFat === nFat && needDifat === nDifat) break;
    nFat = needFat; nDifat = needDifat;
  }
  const fatStart = sec, difatStart = sec + nFat;
  const total = sec + nFat + nDifat;

  const fat = new Uint32Array(nFat * per).fill(FREE);
  const link = (start, count) => { for (let k = 0; k < count; k++) fat[start + k] = k === count - 1 ? END : start + k + 1; };
  datas.forEach((d, i) => { if (regStart.has(i)) link(regStart.get(i), ceil(d.length, S)); });
  if (miniSecs) link(rootStart, miniSecs);
  link(dirStart, dirSecs);
  if (miniFatSecs) link(miniFatStart, miniFatSecs);
  for (let k = 0; k < nFat; k++) fat[fatStart + k] = FATSECT;
  for (let k = 0; k < nDifat; k++) fat[difatStart + k] = DIFSECT;

  const out = new Uint8Array((total + 1) * S);
  const ov = new DataView(out.buffer);
  const at = (n) => (n + 1) * S;

  // 헤더: 원본 앞부분(서명·CLSID·버전·바이트 순서·섹터 크기)을 복사하고 위치 값만 새로
  out.set(cfb.header.subarray(0, 40), 0);
  ov.setUint32(40, major === 4 ? dirSecs : 0, true);
  ov.setUint32(44, nFat, true);
  ov.setUint32(48, dirStart, true);
  ov.setUint32(52, 0, true);
  ov.setUint32(56, cutoff, true);
  ov.setUint32(60, miniFatStart, true);
  ov.setUint32(64, miniFatSecs, true);
  ov.setUint32(68, nDifat ? difatStart : END, true);
  ov.setUint32(72, nDifat, true);
  for (let i = 0; i < 109; i++) ov.setUint32(76 + i * 4, i < nFat ? fatStart + i : FREE, true);
  for (let k = 0; k < nDifat; k++) {
    const base = at(difatStart + k);
    for (let i = 0; i < per - 1; i++) {
      const f = 109 + k * (per - 1) + i;
      ov.setUint32(base + i * 4, f < nFat ? fatStart + f : FREE, true);
    }
    ov.setUint32(base + S - 4, k === nDifat - 1 ? END : difatStart + k + 1, true);
  }

  // 데이터
  datas.forEach((d, i) => {
    if (regStart.has(i)) out.set(d, at(regStart.get(i)));
    else if (miniStart.has(i)) out.set(d, at(rootStart) + miniStart.get(i) * MS);   // 미니 스트림 그릇은 연속 섹터
  });
  const miniFat = new Uint32Array(miniFatSecs * per).fill(FREE);
  datas.forEach((d, i) => {
    if (!miniStart.has(i)) return;
    const s = miniStart.get(i), c = ceil(d.length, MS);
    for (let k = 0; k < c; k++) miniFat[s + k] = k === c - 1 ? END : s + k + 1;
  });
  for (let i = 0; i < miniFat.length; i++) ov.setUint32(at(miniFatStart) + i * 4, miniFat[i], true);
  for (let i = 0; i < fat.length; i++) ov.setUint32(at(fatStart) + i * 4, fat[i], true);

  // 디렉터리: 원본 128바이트 복사 + 시작 섹터·크기만
  const dirBase = at(dirStart);
  entries.forEach((e, i) => {
    const o = dirBase + i * 128;
    out.set(e.raw, o);
    if (e.type === 2) {
      const d = datas[i];
      const start = !d.length ? END : miniStart.has(i) ? miniStart.get(i) : regStart.get(i);
      ov.setUint32(o + 116, start, true);
      ov.setUint32(o + 120, d.length, true);
      ov.setUint32(o + 124, 0, true);
    } else if (e.type === 5) {
      ov.setUint32(o + 116, rootStart, true);
      ov.setUint32(o + 120, miniCount * MS, true);
      ov.setUint32(o + 124, 0, true);
    }
  });
  // 마지막 디렉터리 섹터의 남는 칸은 빈 항목
  for (let i = entries.length; i < dirSecs * (S / 128); i++) {
    const o = dirBase + i * 128;
    ov.setUint32(o + 68, NOSTREAM, true); ov.setUint32(o + 72, NOSTREAM, true); ov.setUint32(o + 76, NOSTREAM, true);
  }
  // 버전 3 은 섹터 512 라 out 크기 = (total+1)*512, 버전 4 는 헤더 섹터 4096 (나머지 0)
  return out;
}
