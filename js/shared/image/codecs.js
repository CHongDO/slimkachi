/* ============================================================
   codecs.js — WASM 인코더/디코더 로더 (jSquash, jsDelivr CDN)
   ------------------------------------------------------------
   jSquash의 래퍼 파일은 'wasm-feature-detect' 같은 bare import 를
   쓰기 때문에 CDN에서 바로 불러올 수 없습니다. 그래서 래퍼 대신
   emscripten/wasm-bindgen 글루 파일을 직접 import 합니다.
   글루는 import.meta.url 기준으로 .wasm 을 받아오므로 CDN에서 그대로 동작.
   ※ 버전을 올릴 때는 아래 V 값과 각 encode() 인자 형태를 함께 확인.
   ============================================================ */

import { t as tx } from '../../i18n/index.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@jsquash';
const V = { jpeg: '1.6.0', webp: '1.5.0', avif: '2.1.1', oxipng: '2.3.0' };

const cache = new Map();
function once(key, fn) {
  if (!cache.has(key)) {
    const p = fn();
    p.catch(() => cache.delete(key)); // 네트워크 실패 시 다음에 재시도
    cache.set(key, p);
  }
  return cache.get(key);
}

async function emscripten(url) {
  const mod = await import(url);
  return mod.default({ noInitialRun: true });
}

// WebAssembly SIMD 지원 여부 (wasm-feature-detect 와 동일한 검사 바이트)
const simd = (() => {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch { return false; }
})();

const loaders = {
  jpegEnc: () => emscripten(`${CDN}/jpeg@${V.jpeg}/codec/enc/mozjpeg_enc.js`),
  webpEnc: () => emscripten(`${CDN}/webp@${V.webp}/codec/enc/${simd ? 'webp_enc_simd' : 'webp_enc'}.js`),
  avifEnc: () => emscripten(`${CDN}/avif@${V.avif}/codec/enc/avif_enc.js`),
  jpegDec: () => emscripten(`${CDN}/jpeg@${V.jpeg}/codec/dec/mozjpeg_dec.js`),
  webpDec: () => emscripten(`${CDN}/webp@${V.webp}/codec/dec/webp_dec.js`),
  avifDec: () => emscripten(`${CDN}/avif@${V.avif}/codec/dec/avif_dec.js`),
  oxipng: async () => {
    const mod = await import(`${CDN}/oxipng@${V.oxipng}/codec/pkg/squoosh_oxipng.js`);
    await mod.default();
    return mod;
  },
};
const load = (name) => once(name, loaders[name]);

/* ---------- 인코더 기본 옵션 (jSquash meta.js 와 동일) ---------- */
const JPEG_DEFAULTS = {
  quality: 75, baseline: false, arithmetic: false, progressive: true, optimize_coding: true,
  smoothing: 0, color_space: 3, quant_table: 3, trellis_multipass: false, trellis_opt_zero: false,
  trellis_opt_table: false, trellis_loops: 1, auto_subsample: true, chroma_subsample: 2,
  separate_chroma_quality: false, chroma_quality: 75,
};
const WEBP_DEFAULTS = {
  quality: 75, target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50, filter_strength: 60,
  filter_sharpness: 0, filter_type: 1, partitions: 0, segments: 4, pass: 1, show_compressed: 0,
  preprocessing: 0, autofilter: 0, partition_limit: 0, alpha_compression: 1, alpha_filtering: 1,
  alpha_quality: 100, lossless: 0, exact: 0, image_hint: 0, emulate_jpeg_size: 0, thread_level: 0,
  low_memory: 0, near_lossless: 100, use_delta_palette: 0, use_sharp_yuv: 0,
};
const AVIF_DEFAULTS = {
  quality: 50, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0, speed: 6,
  subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8,
  lossless: false,
};

/** 형식별 품질 탐색 범위 */
export const QUALITY_RANGE = {
  jpeg: [30, 95],
  webp: [30, 95],
  avif: [20, 90],
};

/**
 * 손실 인코딩. mode: 'size' | 'balanced' | 'quality'
 * extra.gray: JPEG 를 흑백 1채널로 저장 (스캔 문서 등 — RGB 로 저장할 때보다 작음)
 * @returns {Promise<Uint8Array>}
 */
export async function encode(format, img, quality, mode, extra = {}) {
  const { data, width, height } = img;
  if (format === 'jpeg') {
    const m = await load('jpegEnc');
    const opts = { ...JPEG_DEFAULTS, quality };
    if (mode === 'quality') { opts.auto_subsample = false; opts.chroma_subsample = 1; } // 4:4:4
    if (extra.gray) opts.color_space = 1; // JCS_GRAYSCALE
    return new Uint8Array(m.encode(data, width, height, opts));
  }
  if (format === 'webp') {
    const m = await load('webpEnc');
    const opts = { ...WEBP_DEFAULTS, quality, use_sharp_yuv: mode === 'quality' ? 1 : 0 };
    const out = m.encode(data, width, height, opts);
    if (!out) throw new Error(tx('codec.001'));
    return new Uint8Array(out);
  }
  if (format === 'avif') {
    const m = await load('avifEnc');
    const big = width * height > 4_000_000;
    const opts = { ...AVIF_DEFAULTS, quality, speed: big ? 8 : 6, subsample: mode === 'quality' ? 3 : 1 };
    const out = m.encode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, height, opts);
    if (!out) throw new Error(tx('codec.002'));
    return new Uint8Array(out);
  }
  throw new Error(tx('codec.003', { format }));
}

/** PNG 무손실 최적화. bytes(PNG 파일) 또는 ImageData 를 받는다. */
export async function optimisePng(input, level = 2) {
  const m = await load('oxipng');
  if (input instanceof Uint8Array) return new Uint8Array(m.optimise(input, level, false, true));
  return new Uint8Array(m.optimise_raw(input.data, input.width, input.height, level, false, true));
}

/** 브라우저 내장 디코더가 실패했을 때 쓰는 WASM 디코더 */
export async function wasmDecode(format, bytes) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let r;
  if (format === 'jpeg') r = (await load('jpegDec')).decode(buf, false);
  else if (format === 'webp') r = (await load('webpDec')).decode(buf);
  else if (format === 'avif') r = (await load('avifDec')).decode(buf, 8);
  if (!r) throw new Error(tx('codec.004'));
  return r;
}

/** 실제 처리 전에 필요한 코덱을 미리 받아 둔다(첫 장 대기 시간 단축). */
export function preload(formats) {
  const map = { jpeg: 'jpegEnc', webp: 'webpEnc', avif: 'avifEnc', png: 'oxipng' };
  for (const f of formats) if (map[f]) load(map[f]).catch(() => {});
}
