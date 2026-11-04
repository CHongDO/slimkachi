/* ============================================================
   probe.js — 문서를 올리자마자 확인 (썸네일 워커에서, 처리 전)
   ------------------------------------------------------------
   형식이 맞는지 · 처리할 수 없는 보안 문서인지 · 안에 사진이 몇 장인지만 본다.
   사진은 풀지 않고 이름·크기로만 센다(가볍게). 보안 문서는 notice 오류 → 목록에 '처리 불가'로 남음.
   ============================================================ */

import { openDoc } from './open.js';

export async function probeDoc(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  const doc = await openDoc(u8, file.name);
  const photos = doc.images.filter((im) => /\.(jpe?g|png)$/i.test(im.name));
  return {
    doc: true,
    docType: doc.ext,
    images: doc.images.length,                       // 사진으로 보이는 항목 (BMP·GIF 포함)
    compressible: photos.length,                     // 줄일 수 있는 JPG·PNG
    photoBytes: photos.reduce((n, im) => n + (im.size || 0), 0),
  };
}
