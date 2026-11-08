/* ============================================================
   copy.js — PDF 쪽 옮겨 담기 공통부 (워커 전용): 나누기·합치기가 같이 쓴다
   ------------------------------------------------------------
   pdf-lib copyPages 는 쪽(내용 스트림·폰트·이미지)을 바이트 그대로 옮긴다 — 래스터화 없음,
   글자 선택·검색 그대로. 다만 쪽 안의 몇몇 항목이 '다른 쪽'을 가리키고 있으면
   그 쪽과 쪽 트리 전체(= 원본 문서 전부)가 결과 파일마다 딸려 들어간다. 그래서
     ① prepareSource: 옮기기 전에 원본(워커 안의 사본)에서 그런 연결을 끊어 둔다
        - 주석의 /P(속한 쪽), 양식 위젯의 /Parent(필드 트리), 쪽의 /B(기사 흐름)
        - 문서 안 링크(이름 목적지 포함)는 목적지를 '쪽 번호' 표시로 바꿔 둔다
     ② copyInto: 옮긴 뒤 같은 결과 파일 안의 쪽을 가리키는 링크는 새 쪽으로 다시 잇고,
        결과에 없는 쪽을 가리키는 링크는 뺀다
     ③ tidy: 그래도 남은 '결과에 없는 쪽' 참조는 null 로 끊고, 어디서도 안 쓰는 객체는 지운다
   책갈피(목차)·양식 필드 트리(AcroForm)는 문서 단위 정보라 옮겨지지 않는다(화면이 안내).
   ============================================================ */

/**
 * 원본 문서 준비 (한 문서에 한 번). 원본 객체를 직접 고치므로 워커 안의 사본에만 쓴다.
 * @returns {{ lost: { links: number, forms: boolean, outlines: boolean } }}
 */
export function prepareSource(L, doc) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } = L;
  const N = (s) => PDFName.of(s);
  const ctx = doc.context;
  const pages = doc.getPages();
  const index = new Map(pages.map((p, i) => [p.ref.tag, i]));
  const lost = {
    links: 0,
    forms: doc.catalog.has(N('AcroForm')),
    outlines: doc.catalog.has(N('Outlines')),
  };
  let named = null;

  /** 목적지 → [쪽 번호(숫자), 보기 방식…] 새 배열 (못 찾으면 null) */
  const toMarker = (d) => {
    let v = d instanceof PDFRef ? ctx.lookup(d) : d;
    if (!(v instanceof PDFArray)) {
      if (!named) named = namedDests(L, doc);
      let t = v ? named.get(keyOf(L, v)) : null;
      if (t instanceof PDFRef) t = ctx.lookup(t);
      if (t instanceof PDFDict) t = t.lookup(N('D'));
      v = t instanceof PDFArray ? t : null;
    }
    if (!v || v.size() < 1) return null;
    const first = v.get(0);
    if (first instanceof PDFNumber) return v;   // 같은 동작 사전을 여러 주석이 함께 써서 이미 바꾼 것
    if (!(first instanceof PDFRef)) return null;
    const idx = index.get(first.tag);
    if (idx === undefined) return null;
    const arr = PDFArray.withContext(ctx);
    arr.push(PDFNumber.of(idx));
    for (let i = 1; i < v.size(); i++) arr.push(v.get(i));
    return arr;
  };

  for (const page of pages) {
    const node = page.node;
    node.delete(N('B'));   // 기사(아티클) 흐름 — 다른 쪽을 가리킨다
    const annots = node.lookup(N('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let k = annots.size() - 1; k >= 0; k--) {
      const a = annots.lookup(k);
      if (!(a instanceof PDFDict)) continue;
      a.delete(N('P'));                         // 속한 쪽 (선택 항목)
      const sub = nameOf(a.lookup(N('Subtype')));
      if (sub === '/Widget') a.delete(N('Parent'));   // 필드 트리는 끊고 보이는 모습(외형)만 남긴다
      if (sub !== '/Link') continue;
      if (a.has(N('Dest'))) {
        const m = toMarker(a.get(N('Dest')));
        if (m) a.set(N('Dest'), m); else { annots.remove(k); lost.links++; }
        continue;
      }
      const act = a.lookup(N('A'));
      if (act instanceof PDFDict && nameOf(act.lookup(N('S'))) === '/GoTo') {
        const m = toMarker(act.get(N('D')));
        if (m) act.set(N('D'), m); else { annots.remove(k); lost.links++; }
      }
    }
  }
  return { lost };
}

/**
 * 원본 doc 의 쪽(0부터 번호) 들을 out 에 차례로 붙이고 링크를 다시 잇는다.
 * @returns {Promise<number>} 결과에 없는 쪽을 가리켜서 뺀 링크 수
 */
export async function copyInto(L, out, src, indices) {
  const { PDFName, PDFDict, PDFArray, PDFNumber } = L;
  const N = (s) => PDFName.of(s);
  const copied = await out.copyPages(src, indices);
  const map = new Map();
  copied.forEach((p, k) => { out.addPage(p); map.set(indices[k], p.ref); });
  let dropped = 0;
  const relink = (arr) => {
    if (!(arr instanceof PDFArray) || arr.size() < 1) return true;
    const first = arr.get(0);
    if (!(first instanceof PDFNumber)) return true;
    const to = map.get(first.asNumber());
    if (!to) return false;
    arr.set(0, to);
    return true;
  };
  for (const p of copied) {
    const annots = p.node.lookup(N('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let k = annots.size() - 1; k >= 0; k--) {
      const a = annots.lookup(k);
      if (!(a instanceof PDFDict) || nameOf(a.lookup(N('Subtype'))) !== '/Link') continue;
      let ok = true;
      if (a.has(N('Dest'))) ok = relink(a.lookup(N('Dest')));
      else {
        const act = a.lookup(N('A'));
        if (act instanceof PDFDict && nameOf(act.lookup(N('S'))) === '/GoTo') ok = relink(act.lookup(N('D')));
      }
      if (!ok) { annots.remove(k); dropped++; }
    }
  }
  return dropped;
}

/**
 * 저장 전 정리: 결과에 없는 쪽을 가리키는 참조는 null 로 끊고,
 * 문서 뿌리(Root·Info)에서 닿지 않는 객체는 지운다 (pdf-lib 는 안 쓰는 객체도 그대로 저장하므로).
 * 먼저 out.flush() 로 넣기로 한 사진·폰트를 실제 객체로 만들어 둘 것.
 */
export function tidy(L, out) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFNull } = L;
  const ctx = out.context;
  const keep = new Set(out.getPages().map((p) => p.ref.tag));
  const typeKey = PDFName.of('Type');
  const stray = (ref) => {
    if (keep.has(ref.tag)) return false;
    const o = ctx.lookup(ref);
    return o instanceof PDFDict && nameOf(o.get(typeKey)) === '/Page';
  };
  const seen = new Set();
  const stack = [];
  const visit = (ref) => {
    if (seen.has(ref.tag)) return;
    seen.add(ref.tag);
    const o = ctx.lookup(ref);
    if (o) stack.push(o);
  };
  for (const r of [ctx.trailerInfo.Root, ctx.trailerInfo.Info]) {
    if (r instanceof PDFRef) visit(r); else if (r) stack.push(r);
  }
  while (stack.length) {
    const o = stack.pop();
    const d = o instanceof PDFStream ? o.dict : o;
    if (d instanceof PDFDict) {
      for (const [k, v] of d.entries()) {
        if (v instanceof PDFRef) { if (stray(v)) d.set(k, PDFNull); else visit(v); }
        else if (v instanceof PDFDict || v instanceof PDFArray) stack.push(v);
      }
    } else if (d instanceof PDFArray) {
      for (let i = 0; i < d.size(); i++) {
        const v = d.get(i);
        if (v instanceof PDFRef) { if (stray(v)) d.set(i, PDFNull); else visit(v); }
        else if (v instanceof PDFDict || v instanceof PDFArray) stack.push(v);
      }
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) { ctx.delete(ref); removed++; }
  }
  return removed;
}

/** 결과 저장 (객체 스트림으로 촘촘하게, 워커라 쉬어 가며 저장할 필요 없음) */
export async function saveDoc(out) {
  await out.flush();
  return out.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 2000 });
}

/* ---------- 이름 목적지 (/Dests 사전 · /Names /Dests 이름 트리) ---------- */
function namedDests(L, doc) {
  const { PDFName, PDFDict, PDFArray } = L;
  const N = (s) => PDFName.of(s);
  const map = new Map();
  const cat = doc.catalog;
  const old = cat.lookup(N('Dests'));
  if (old instanceof PDFDict) for (const [k, v] of old.entries()) map.set(keyOf(L, k), v);
  const names = cat.lookup(N('Names'));
  const walk = (node, depth) => {
    if (!(node instanceof PDFDict) || depth > 32) return;
    const arr = node.lookup(N('Names'));
    if (arr instanceof PDFArray) {
      for (let i = 0; i + 1 < arr.size(); i += 2) map.set(keyOf(L, arr.lookup(i)), arr.get(i + 1));
    }
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i), depth + 1);
  };
  if (names instanceof PDFDict) walk(names.lookup(N('Dests')), 0);
  return map;
}

function keyOf(L, v) {
  if (v instanceof L.PDFName) return v.asString().replace(/^\//, '');
  if (v && typeof v.decodeText === 'function') return v.decodeText();
  return String(v);
}

const nameOf = (v) => (v ? v.toString() : '');
