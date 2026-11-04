/* ============================================================
   formats.js — 사진 저장 형식 규칙 (화면·워커 공용, 가벼운 상수만)
   ------------------------------------------------------------
   형식 이름은 metadata.js 의 detectType() 값: jpeg png webp gif bmp ico avif heic tiff (모르면 'unknown')
   ============================================================ */

/** 원본 형식 그대로 저장할 수 있는 형식 (그 밖은 저장 형식을 바꿔야 함) */
export const SAVEABLE = ['jpeg', 'png', 'webp'];

/** 고를 수 있는 저장 형식 ('same' = 원본 유지는 따로) */
export const OUTPUTS = ['jpeg', 'png', 'webp', 'avif'];

/**
 * 원본 형식으로 저장할 수 없는 사진의 기본 저장 형식.
 * BMP·TIFF·GIF·ICO 등 → PNG(무손실), HEIC/HEIF → JPG.
 * AVIF 도 손실 사진 형식이라 JPG (PNG 로 바꾸면 몇 배로 커짐).
 */
export function autoFormat(type) {
  return type === 'heic' || type === 'avif' ? 'jpeg' : 'png';
}

/** 요청한 저장 형식('same' | OUTPUTS) → 실제로 쓸 형식 */
export function outputFormat(requested, type) {
  if (OUTPUTS.includes(requested)) return requested;
  return SAVEABLE.includes(type) ? type : autoFormat(type);
}

/** 화면에 보이는 형식 이름 */
export const FORMAT_NAME = {
  jpeg: 'JPG', png: 'PNG', webp: 'WebP', avif: 'AVIF', gif: 'GIF', bmp: 'BMP', ico: 'ICO',
  heic: 'HEIC', tiff: 'TIFF', pdf: 'PDF',
};

/** 손실 압축 사진 형식 (PNG 로 바꿔도 이미 줄어든 화질은 돌아오지 않음) */
export const LOSSY_SOURCES = ['jpeg', 'heic', 'avif'];
