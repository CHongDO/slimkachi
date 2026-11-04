<p align="center">
  <img src="docs/kachi.svg" width="128" height="128" alt="SlimKachi 마스코트 선비 까치">
</p>

<h1 align="center">SlimKachi</h1>

<p align="center">
  사진 · PDF · 문서 용량 줄이기 — 업로드 없이, 브라우저 안에서 무료로<br>
  <a href="https://slimkachi.pages.dev">slimkachi.pages.dev</a>
</p>

---

## 소개

SlimKachi(슬림까치)는 파일을 서버에 올리지 않고 **내 브라우저 안에서만** 용량을 줄이는 정적 웹사이트입니다.
화질 손실은 최소로, 용량은 가볍게. 파일은 한 번도 기기 밖으로 나가지 않습니다.

## 마스코트

### 선비 까치 — 대표 마스코트
<img src="docs/kachi.svg" width="64" height="64" alt="선비 까치" align="left">

갓을 쓰고 두루마리를 문 까치. 로고와 파비콘에 쓰이는 SlimKachi의 얼굴입니다.
무거운 파일을 두루마리처럼 가볍게 말아 전해 준다는 뜻을 담았습니다.
낮 풍경에서 천천히, 점잖게 날아다닙니다.

<br clear="left">

### 까치 — 날아다니는 친구
사이트 첫 화면의 벚꽃 풍경을 가로질러 날다가 풀밭에 내려앉았다 다시 떠나는 까치입니다.
선비 까치와 따로 움직이며, 밤 테마에서는 쉬러 가서 나타나지 않습니다.

> 두 캐릭터와 로고는 SlimKachi를 위해 직접 만든 픽셀 아트 창작물입니다.

## 브랜드 컬러

| 이름 | 용도 | 값 |
|---|---|---|
| 인주 | SLIM 배지, 포인트 (낮) | `#C8402F` |
| 인주 (밤) | SLIM 배지 (밤) | `#D9533F` |
| 한지 | 두루마리, 아이콘 배경 | `#F3E3C3` |
| 호박 | 부리 | `#D9A441` |
| 먹 | 까치 몸, 갓 | `#1E1A24` |

## 기능

- **사진 압축** — 화질 지표(SSIM)로 품질을 자동으로 찾아 최소 손실로 압축
- **크기 조정** — 비율 / 픽셀 / 목표 용량 기준
- **형식 변환** — 원본 유지 · JPG · PNG · WebP
- **PDF 압축** — 페이지를 이미지로 바꾸지 않고 안의 이미지만 압축
- **문서 압축** — HWP · HWPX · DOCX · PPTX · XLSX 안의 이미지만 압축 (같은 형식 유지)
- **지원 입력** — JPG, PNG, WebP, BMP, GIF, ICO, AVIF, HEIC, TIFF 등
- **한 번에 처리** — 여러 파일 업로드 → 결과 비교 → ZIP으로 내보내기

## 기술

- HTML · CSS · JavaScript (ES Modules), 빌드 도구 없음
- Cloudflare Pages 정적 배포
- WebAssembly 인코더 + Web Worker로 브라우저 안에서 처리
- MIT / Apache-2.0 등 허용 라이선스 라이브러리만 사용 (GPL · AGPL 미사용)

## 개인정보

모든 처리는 사용자의 브라우저에서 이루어지며, 파일은 서버로 전송되거나 저장되지 않습니다.
