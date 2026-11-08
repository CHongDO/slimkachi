/* ============================================================
   limits.js — 업로드 한도 (위험 계수). 숫자는 모두 여기서만 조정한다.
   ------------------------------------------------------------
   기준 기기: i5-6500 / RAM 4GB. 처리 중 멈추거나 탭이 죽을 만한 파일·분량을 올리기 전에 막는다.
   사진: 위험 계수(추정 작업 메모리, 바이트) = 가로 × 세로 × 4(RGBA) × 3(원본·축소본·검증용 사본)
         가로·세로는 헤더만 읽어서(imageSize.js), 못 구하면 파일 용량 × 12 로 어림
   PDF : 파일 용량 그대로 한도와 비교 (위험 계수 아님)
   한도: 기본(모든 기기) / navigator.deviceMemory 가 8 이상으로 확인될 때만 넉넉하게.
   deviceMemory 를 모르는 브라우저(파이어폭스·사파리 등)는 기본값.
   단위 1MB = 1,000,000 바이트.
   ============================================================ */

import { imageDims } from './imageSize.js';
import { t as tx } from '../i18n/index.js';

export const MB = 1000 * 1000;

export const RISK = {
  photoBytesPerPixel: 4 * 3,   // RGBA 4바이트 × 사본 3개
  photoFallbackPerByte: 12,    // 헤더로 크기를 못 구한 사진: 파일 용량 × 12
};

export const LIMITS = {
  // photo = 사진 위험 계수 한도 · pdf·doc = PDF·문서 파일 용량 한도 · count·total = 목록 전체 개수·파일 용량 합
  // splitParts = PDF 나누기 한 번에 만들 수 있는 결과 파일 수 (나눈 파일은 목록 개수 한도와 따로, 용량 합에는 포함)
  base:  { photo: 300 * MB, pdf: 80 * MB,  doc: 80 * MB,  count: 30, total: 300 * MB, splitParts: 100 },   // 모든 기기
  roomy: { photo: 600 * MB, pdf: 150 * MB, doc: 150 * MB, count: 50, total: 500 * MB, splitParts: 200 },   // deviceMemory ≥ ROOMY_MEMORY_GB
};

/**
 * 합치기 결과 PDF 용량 어림 (바이트). 합치기 전에 한도(PDF 파일 한도·목록 용량 합)를 넘을지 미리 알리는 데 쓴다.
 *  PDF·JPG = 파일 용량 그대로 (바이트를 그대로 옮김)
 *  그 밖의 사진은 다시 압축하지 않고 풀어서 무손실(Flate)로 넣는다 (merge.js) —
 *    HEIC·AVIF·WebP(찍은 사진) = 화소당 약 2.2바이트 (자잘한 노이즈 때문에 Flate 가 잘 안 줄어 RGB 3바이트의 약 3/4)
 *    PNG·BMP·TIFF·GIF 등      = 화소당 약 1.5바이트 (그림·화면 캡처가 많아 RGB 3바이트의 절반)
 *  크기를 모르는 사진은 파일 용량 × 3
 */
export const MERGE_RATE = { photoPerPixel: 2.2, losslessPerPixel: 1.5, unknownPerByte: 3 };
export function mergeEstimate({ kind, size, type, width, height }) {
  if (kind === 'pdf' || type === 'jpeg') return size;
  const px = width * height;
  if (!(px > 0)) return size * MERGE_RATE.unknownPerByte;
  const photo = type === 'heic' || type === 'avif' || type === 'webp';
  return Math.max(size, Math.round(px * (photo ? MERGE_RATE.photoPerPixel : MERGE_RATE.losslessPerPixel)));
}
export const ROOMY_MEMORY_GB = 8;

/** 이 기기에 적용할 한도 (+ 화면 표시용 환산값) */
export function currentLimits() {
  const dm = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  const roomy = typeof dm === 'number' && dm >= ROOMY_MEMORY_GB;
  const l = roomy ? LIMITS.roomy : LIMITS.base;
  return {
    ...l,
    tier: roomy ? 'roomy' : 'base',
    maxPixels: l.photo / RISK.photoBytesPerPixel,         // 사진 최대 화소 수
    maxPhotoFile: l.photo / RISK.photoFallbackPerByte,     // 크기를 모르는 사진의 최대 파일 용량
    maxPdfFile: l.pdf,                                      // PDF 최대 파일 용량
    maxDocFile: l.doc,                                      // 문서(한글·오피스) 최대 파일 용량
  };
}

/**
 * 파일 하나의 위험 계수.
 * @returns {Promise<{ risk:number, width?:number, height?:number, byHeader:boolean }>}
 */
export async function assess(file, kind) {
  if (kind === 'pdf') return { risk: file.size, byHeader: false };   // PDF 는 파일 용량 그대로
  if (kind === 'doc') return { risk: file.size, byHeader: false, sigError: await docSignature(file) };   // 문서도 파일 용량 (안의 사진은 한 장씩 처리·해제)
  const d = await imageDims(file);
  if (d) return { risk: d.width * d.height * RISK.photoBytesPerPixel, width: d.width, height: d.height, byHeader: true };
  return { risk: file.size * RISK.photoFallbackPerByte, byHeader: false };
}

/** 문서: 확장자와 파일 시그니처(ZIP 'PK' / 복합 파일 D0 CF 11 E0)가 맞는지. 맞으면 '' */
async function docSignature(file) {
  const h = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const zip = h[0] === 0x50 && h[1] === 0x4b;
  const cfb = h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0;
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [])[1]?.toLowerCase() || '';
  const E = ext.toUpperCase();
  if (ext === 'hwp') {
    if (cfb) return '';
    return String.fromCharCode(...h.subarray(0, 17)) === 'HWP Document File'
      ? tx('lim.001') : tx('lim.002');
  }
  if (ext === 'hwpx') return zip ? '' : tx('lim.003');
  // 워드·파워포인트·엑셀: 보통 ZIP, 암호를 걸면 복합 파일 (암호 문서는 목록에 넣고 '처리 불가'로 안내)
  return zip || cfb ? '' : tx('lim.004', { E });
}

/** 'MB' 표기 (정수면 소수점 없이) */
export const mbText = (bytes) => {
  const v = bytes / MB;
  return `${v >= 10 ? Math.floor(v) : +v.toFixed(1)}MB`;
};
/** 화소 수 → '2,500만 화소' */
export const mpText = (px) => tx('fmt.mp', { px });   // 언어마다 표기가 달라 사전의 함수가 만든다 (ko 2,500만 화소 · en 25 megapixels · ja 2,500万画素)
