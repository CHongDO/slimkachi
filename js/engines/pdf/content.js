/* ============================================================
   content.js — 페이지 내용(content stream)을 읽어 이미지가
   실제로 얼마나 크게 그려지는지(포인트 단위) 알아낸다. (워커 전용)
   ------------------------------------------------------------
   그래픽 상태 q/Q, 좌표 변환 cm, 이미지 그리기 Do 만 따라간다.
   Form XObject 안에서 그려지는 이미지도 Matrix 를 곱해 따라간다.
   읽기만 하며 내용은 절대 바꾸지 않는다(글자·벡터는 손대지 않음).
   ============================================================ */

const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_DEPTH = 8;
const MAX_SCAN_BYTES = 300 * 1024 * 1024; // 비정상 파일에서 끝없이 도는 것 방지

/** m × t (PDF 행렬 [a b c d e f]) */
function mul(m, t) {
  return [
    m[0] * t[0] + m[1] * t[2], m[0] * t[1] + m[1] * t[3],
    m[2] * t[0] + m[3] * t[2], m[2] * t[1] + m[3] * t[3],
    m[4] * t[0] + m[5] * t[2] + t[4], m[4] * t[1] + m[5] * t[3] + t[5],
  ];
}

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

/**
 * @returns Map<refTag, { w, h }>  이미지별 가장 크게 그려진 폭·높이(포인트)
 */
export function measureImageUse(L, doc) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream } = L;
  const ctx = doc.context;
  const sizes = new Map();
  const formCache = new Map();
  let scanned = 0;

  const N = (s) => PDFName.of(s);
  const num = (o) => (o && typeof o.asNumber === 'function' ? o.asNumber() : NaN);

  function decode(stream) {
    if (!(stream instanceof PDFRawStream)) return null;
    try { return decodePDFRawStream(stream).decode(); } catch { return null; }
  }

  function inheritedResources(node) {
    let n = node;
    for (let i = 0; n && i < 32; i++) {
      const r = n.lookup(N('Resources'));
      if (r instanceof PDFDict) return r;
      const parent = n.lookup(N('Parent'));
      n = parent instanceof PDFDict ? parent : null;
    }
    return null;
  }

  function pageContentBytes(pageNode) {
    const c = pageNode.lookup(N('Contents'));
    const parts = [];
    if (c instanceof PDFArray) {
      for (let i = 0; i < c.size(); i++) {
        const s = c.lookup(i);
        const b = decode(s);
        if (b) parts.push(b);
      }
    } else {
      const b = decode(c);
      if (b) parts.push(b);
    }
    // 여러 조각은 공백을 끼워 이어 붙인다 (조각 경계에서 토큰이 붙지 않게)
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
    return out;
  }

  function onDo(name, res, ctm, depth) {
    if (!res) return;
    const xobjs = res.lookup(N('XObject'));
    if (!(xobjs instanceof PDFDict)) return;
    const raw = xobjs.get(N(name));
    if (!(raw instanceof PDFRef)) return;
    const xo = ctx.lookup(raw);
    if (!(xo instanceof PDFRawStream)) return;
    const sub = xo.dict.lookup(N('Subtype'));
    if (!sub) return;
    if (sub.toString() === '/Image') {
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      const prev = sizes.get(raw.tag);
      if (!prev) sizes.set(raw.tag, { w, h });
      else { prev.w = Math.max(prev.w, w); prev.h = Math.max(prev.h, h); }
    } else if (sub.toString() === '/Form' && depth < MAX_DEPTH) {
      let m = IDENTITY;
      const mx = xo.dict.lookup(N('Matrix'));
      if (mx instanceof PDFArray && mx.size() === 6) {
        const v = [0, 1, 2, 3, 4, 5].map((i) => num(mx.lookup(i)));
        if (v.every(Number.isFinite)) m = v;
      }
      const fr = xo.dict.lookup(N('Resources'));
      let bytes = formCache.get(raw.tag);
      if (bytes === undefined) { bytes = decode(xo); formCache.set(raw.tag, bytes); }
      if (bytes) scan(bytes, fr instanceof PDFDict ? fr : res, mul(m, ctm), depth + 1);
    }
  }

  function scan(b, res, ctm0, depth) {
    scanned += b.length;
    if (scanned > MAX_SCAN_BYTES) return;
    const n = b.length;
    const nums = [];
    let lastName = null;
    let ctm = ctm0;
    const saved = [];
    let i = 0;
    while (i < n) {
      const c = b[i];
      if (isWs(c)) { i++; continue; }
      if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // % 주석
      if (c === 40) { // ( 문자열 ) — 괄호 중첩과 \ 이스케이프
        let d = 0;
        for (; i < n; i++) {
          const x = b[i];
          if (x === 92) { i++; continue; }
          if (x === 40) d++;
          else if (x === 41 && --d === 0) { i++; break; }
        }
        nums.length = 0; lastName = null;
        continue;
      }
      if (c === 60) {
        if (b[i + 1] === 60) { i += 2; continue; } // <<
        while (i < n && b[i] !== 62) i++;          // <hex>
        i++;
        continue;
      }
      if (c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 41) { i++; continue; }
      if (c === 47) { // /이름
        let j = i + 1;
        while (j < n && !isWs(b[j]) && !isDelim(b[j])) j++;
        lastName = decodeName(b, i + 1, j);
        i = j;
        continue;
      }
      let j = i;
      while (j < n && !isWs(b[j]) && !isDelim(b[j])) j++;
      if (j === i) { i++; continue; }
      const tok = String.fromCharCode.apply(null, b.subarray(i, Math.min(j, i + 16)));
      i = j;
      const ch = tok.charCodeAt(0);
      if ((ch >= 48 && ch <= 57) || ch === 45 || ch === 43 || ch === 46) {
        nums.push(Number(tok));
        if (nums.length > 6) nums.shift();
        continue;
      }
      switch (tok) {
        case 'q': saved.push(ctm); break;
        case 'Q': if (saved.length) ctm = saved.pop(); break;
        case 'cm':
          if (nums.length === 6 && nums.every(Number.isFinite)) ctm = mul(nums.slice(), ctm);
          break;
        case 'Do': if (lastName) onDo(lastName, res, ctm, depth); break;
        case 'BI': i = skipInlineImage(b, i); break;
        default: break;
      }
      nums.length = 0;
      lastName = null;
    }
  }

  for (const page of doc.getPages()) {
    try {
      const node = page.node;
      scan(pageContentBytes(node), inheritedResources(node), IDENTITY, 0);
    } catch (e) {
      console.warn('content scan', e);
    }
  }
  return sizes;
}

function decodeName(b, s, e) {
  let out = '';
  for (let k = s; k < e; k++) {
    if (b[k] === 35 && k + 2 < e) { // #xx
      out += String.fromCharCode(parseInt(String.fromCharCode(b[k + 1], b[k + 2]), 16));
      k += 2;
    } else out += String.fromCharCode(b[k]);
  }
  return out;
}

/** BI ... ID <이진 데이터> EI — 이진 데이터를 건너뛴다 */
function skipInlineImage(b, i) {
  const n = b.length;
  // ID 찾기
  for (; i < n - 2; i++) {
    if (b[i] === 73 && b[i + 1] === 68 && isWs(b[i - 1]) && isWs(b[i + 2])) { i += 3; break; }
  }
  // 공백 + EI + 공백(또는 끝)
  for (; i < n - 2; i++) {
    if (isWs(b[i]) && b[i + 1] === 69 && b[i + 2] === 73 && (i + 3 >= n || isWs(b[i + 3]))) return i + 3;
  }
  return n;
}
