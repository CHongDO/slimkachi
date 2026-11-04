/* ============================================================
   ssim.js — 원본 대비 화질 측정 (SSIM + 블록 경계 왜곡)
   ------------------------------------------------------------
   1) SSIM: 밝기(luma) 채널을 8×8 블록 단위로 비교.
      mean = 평균, low = 하위 2% 블록 값(국소적 뭉개짐 감지).
   2) blockiness: SSIM은 매끈한 그라데이션(하늘, 어두운 배경)에서
      생기는 '계단/네모 블록'·'얼룩/밴딩'을 거의 못 잡습니다. 그래서
      원본이 매끈한 8×8 블록 중 다음 중 하나라도 해당하는 비율을 셉니다.
       - 결과에서 블록 경계에만 단차가 새로 생김 (JPEG 계단 현상)
       - 평균 색 오차가 SMOOTH_ERR 이상 (AVIF/WebP 큰 블록 뭉개짐)
      R·G·B 중 가장 큰 차이로 계산해 색 번짐도 포함합니다.
   픽셀을 한 번만 훑으며 블록 합계를 쌓아 메모리를 거의 쓰지 않습니다.
   투명 이미지는 흰 배경에 합성한 모습으로 비교합니다.
   ============================================================ */

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const B = 8;
const HIST = 1000;

// 블록 경계 단차 판정 기준 (0~255 단위)
const SMOOTH_ORIG = 2.0;   // 원본 블록 내부 평균 변화량이 이보다 작으면 '매끈한 영역'
const STEP_MIN = 2.0;      // 결과의 경계 단차가 원본보다 이만큼 이상 커지면 의심 (1단계 차이는 반올림 수준이라 무시)
const STEP_RATIO = 1.8;
const SMOOTH_ERR = 3.0;     // 매끈한 블록의 평균 색 오차(0~255)가 이 이상이면 얼룩·밴딩 (AVIF/WebP의 큰 블록 뭉개짐)

function luma(d, i, opaque) {
  const l = (77 * d[i] + 150 * d[i + 1] + 29 * d[i + 2]) / 256;
  if (opaque) return l;
  const al = d[i + 3];
  return (l * al + 255 * (255 - al)) / 255;
}

function maxDiff2(a, b, i) {
  const r = a[i] - b[i], g = a[i + 1] - b[i + 1], bl = a[i + 2] - b[i + 2];
  return Math.max(r < 0 ? -r : r, g < 0 ? -g : g, bl < 0 ? -bl : bl);
}

function maxDiff(d, i, j) {
  const r = d[i] - d[j], g = d[i + 1] - d[j + 1], b = d[i + 2] - d[j + 2];
  return Math.max(r < 0 ? -r : r, g < 0 ? -g : g, b < 0 ? -b : b);
}

/**
 * @param scale 1 = 원본 해상도로 SSIM, 2 = 2×2 평균(절반 해상도)으로 SSIM.
 *   큰 사진은 화면에서 축소되어 보이므로 미세 노이즈(그레인) 손실에 과민하지 않게 2를 쓴다.
 *   블록 현상 측정은 항상 원본 해상도.
 */
export function ssim(a, b, width, height, opaque = true, scale = 1) {
  const cols = Math.ceil(width / B);
  const sw = scale === 2 ? width >> 1 : width;
  const scols = Math.ceil(sw / B);
  const sx = new Float64Array(scols), sy = new Float64Array(scols);
  const sxx = new Float64Array(scols), syy = new Float64Array(scols), sxy = new Float64Array(scols);
  const cnt = new Uint32Array(scols);
  // 블록 경계/내부 인접 픽셀 차이 합 (a=원본, b=결과)
  const bdA = new Float64Array(cols), bdB = new Float64Array(cols), bn = new Uint32Array(cols);
  const inA = new Float64Array(cols), inB = new Float64Array(cols), inn = new Uint32Array(cols);
  // 같은 위치 픽셀의 색 오차 합 (매끈한 영역 얼룩·밴딩 감지용)
  const er = new Float64Array(cols), ern = new Uint32Array(cols);
  const hist = new Uint32Array(HIST + 1);
  let total = 0, blocks = 0, gridBlocks = 0, blocky = 0;
  const row = width * 4;

  for (let y = 0; y < height; y++) {
    let i = y * row;
    const yEdge = y % B === 0;
    for (let x = 0; x < width; x++, i += 4) {
      const aa = a[i + 3];
      // SSIM 누적 (scale 2면 홀수 좌표에서 2×2 평균)
      if (scale === 1) {
        const ya = luma(a, i, opaque), yb = luma(b, i, opaque);
        const c = (x / B) | 0;
        sx[c] += ya; sy[c] += yb; sxx[c] += ya * ya; syy[c] += yb * yb; sxy[c] += ya * yb; cnt[c]++;
      } else if ((x & 1) && (y & 1) && (x >> 1) < sw) {
        const i1 = i - 4, i2 = i - row, i3 = i2 - 4;
        const ya = (luma(a, i, opaque) + luma(a, i1, opaque) + luma(a, i2, opaque) + luma(a, i3, opaque)) / 4;
        const yb = (luma(b, i, opaque) + luma(b, i1, opaque) + luma(b, i2, opaque) + luma(b, i3, opaque)) / 4;
        const c = ((x >> 1) / B) | 0;
        sx[c] += ya; sy[c] += yb; sxx[c] += ya * ya; syy[c] += yb * yb; sxy[c] += ya * yb; cnt[c]++;
      }

      // 블록 현상 측정 (불투명 픽셀만)
      if (opaque || aa === 255) {
        const c = (x / B) | 0;
        er[c] += maxDiff2(a, b, i); ern[c]++;
        if (x > 0) {
          const j = i - 4;
          if (x % B === 0) { bdA[c] += maxDiff(a, i, j); bdB[c] += maxDiff(b, i, j); bn[c]++; }
          else { inA[c] += maxDiff(a, i, j); inB[c] += maxDiff(b, i, j); inn[c]++; }
        }
        if (y > 0) {
          const j = i - row;
          if (yEdge) { bdA[c] += maxDiff(a, i, j); bdB[c] += maxDiff(b, i, j); bn[c]++; }
          else { inA[c] += maxDiff(a, i, j); inB[c] += maxDiff(b, i, j); inn[c]++; }
        }
      }
    }
    // SSIM 블록 줄 마감
    const sEnd = scale === 1 ? ((y + 1) % B === 0 || y === height - 1)
                             : ((y & 1) && ((((y >> 1) + 1) % B === 0) || y + 2 >= height));
    if (sEnd) {
      for (let c = 0; c < scols; c++) {
        const n = cnt[c];
        if (!n) continue;
        const mx = sx[c] / n, my = sy[c] / n;
        const vx = sxx[c] / n - mx * mx;
        const vy = syy[c] / n - my * my;
        const cov = sxy[c] / n - mx * my;
        const s = ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
        total += s; blocks++;
        hist[Math.max(0, Math.min(HIST, Math.round(s * HIST)))]++;
        sx[c] = sy[c] = sxx[c] = syy[c] = sxy[c] = 0; cnt[c] = 0;
      }
    }
    // 블록 현상 줄 마감 (원본 해상도 8×8)
    if ((y + 1) % B === 0 || y === height - 1) {
      for (let c = 0; c < cols; c++) {
        if (bn[c] >= 4 && inn[c] >= 8) {
          gridBlocks++;
          const io = inA[c] / inn[c];
          if (io < SMOOTH_ORIG) {
            const bo = bdA[c] / bn[c], bc = bdB[c] / bn[c], ic = inB[c] / inn[c];
            const step = bc - bo >= STEP_MIN && bc >= STEP_RATIO * ic + 0.3;
            const smear = ern[c] && er[c] / ern[c] >= SMOOTH_ERR;
            if (step || smear) blocky++;
          }
        }
        bdA[c] = bdB[c] = inA[c] = inB[c] = er[c] = 0; bn[c] = inn[c] = ern[c] = 0;
      }
    }
  }

  // 하위 2% 지점
  const target = blocks * 0.02;
  let acc = 0, low = 1;
  for (let k = 0; k <= HIST; k++) {
    acc += hist[k];
    if (acc >= target) { low = k / HIST; break; }
  }
  return {
    mean: blocks ? total / blocks : 1,
    low,
    // 전체 블록 중 '매끈한 곳에 생긴 블록 경계 또는 얼룩' 비율
    blockiness: gridBlocks ? blocky / gridBlocks : 0,
  };
}
