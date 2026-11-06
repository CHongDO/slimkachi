# CLAUDE.md — 프로젝트 작업 안내서 (SlimKachi)

이 파일은 Claude Code가 작업 시작 시 자동으로 읽습니다. 규칙을 지켜 구조를 일관되게 유지하세요.

## 프로젝트 목적
- **이름**: SlimKachi (슬림까치). 화면·제목·메타·문서에 이 이름을 쓴다. 로고 = [까치 아이콘][SLIM 배지] Kachi.
- **무엇**: 파일 용량을 줄여 주는 무료 웹 도구. 한 화면(작업실)에서 사진(브라우저가 여는 형식 전부 + HEIC·TIFF)과 PDF를 섞어 올리고,
  파일마다 설정 → 적용 → 확인 → 내보내기. 기능: 사진 용량 줄이기 · 사진 크기 조정 · 사진 형식 변환 · PDF 용량 줄이기
  · 문서(HWP·HWPX·DOCX·PPTX·XLSX) 용량 줄이기(문서 안 사진만).
- **핵심 가치**: 업로드 없음. 모든 처리가 사용자 브라우저 안에서 끝난다.
- **배포 대상**: Cloudflare Pages (정적 호스팅, 빌드 없음). 임시 도메인 `slimkachi.pages.dev`
- **수익화**: Google AdSense → 문서 페이지(pages/)와 SEO 메타 유지 필수

## 절대 원칙 (어기지 말 것)
1. **파일은 절대 서버로 전송하지 않는다.**
   사용자 파일(원본·결과·썸네일 어느 것이든)을 fetch/XHR/beacon/WebSocket/폼 전송 등으로
   외부에 보내는 코드는 금지. 분석·로그에 파일명이나 메타데이터를 싣는 것도 금지.
   네트워크 요청은 코드(라이브러리) 내려받기와 광고 스크립트뿐이어야 한다.
   개인정보처리방침과 페이지 하단 안내 문구가 이 약속을 공개적으로 하고 있다.
2. **용량 최대 감소 + 화질 손실 최소.**
   - 무손실로 줄일 수 있는 것(메타데이터, PNG 최적화)은 항상 먼저 한다.
   - 손실 압축은 화질 측정(SSIM + 블록/얼룩 검사)을 통과한 결과만 쓴다. 품질 값을 고정하지 않는다.
   - 결과가 원본보다 크면 원본 유지. 손실 재인코딩은 무손실 최선보다 5% 이상 줄 때만 채택.
   - 색 프로필·사진 방향처럼 "보이는 모습"에 영향을 주는 정보는 지우지 않는다.
   - 움직이는 이미지(APNG, 애니메이션 WebP)는 재인코딩하지 않는다(움직임 손실).
   - 원본보다 크게 늘리지 않는다(업스케일 금지).
   - PDF: 글자·벡터(내용 스트림, 폰트)는 바꾸지 않는다. 페이지를 그림으로 바꾸는 래스터화 금지
     (글자 선택·검색이 유지돼야 함). 바꾸는 건 이미지 객체와 무손실 구조 정리뿐.
   - 문서(한글·오피스): 사진(JPG·PNG)만 같은 형식으로 재압축. 글자·표·서식·구조·다른 항목은 바이트 그대로, 형식 변환 금지.
     보안 문서(암호·배포용·DRM·전자 서명)는 손대지 않고 안내.
3. **빌드 도구 없음**: 번들러·트랜스파일러 금지. 순수 HTML/CSS/JS + 브라우저 ES 모듈.
4. **외부 라이브러리는 CDN(cdnjs / jsdelivr)만**, 항상 **정확한 버전 고정** (`@1.6.0` 처럼).
   npm 설치·로컬 복사 금지. **상업적 사용이 자유로운 라이선스만**(MIT·Apache-2.0·BSD·ISC 등).
   GPL/AGPL(예: Ghostscript WASM)은 금지. LGPL 은 CDN 의 별도 파일을 그대로 불러올 때만 허용(지금은 HEIC 용 libheif-js). 라이브러리는 그 종류의 파일을 처음 다룰 때만 불러온다(지연 로딩 — 사진만 다루면 PDF 라이브러리를 받지 않음).
5. **색·간격·폰트는 `css/theme.css` 변수로만**. 다른 CSS/JS에 색값(#hex, rgb) 하드코딩 금지.
   배경 그림(SVG)도 색 없는 마스크로 두고 색은 변수로 칠한다. 테마 규칙은 아래 '디자인 테마' 절.
   예외: assets/favicon.svg·favicon.ico·og-image.png 는 파일이라 CSS 변수를 못 읽어 브랜드 색값을 직접 쓴다(theme.css 와 같은 값).
6. **무거운 처리는 Web Worker에서**. 메인 스레드에서 픽셀 루프·인코딩·큰 이미지 디코딩 금지.
   목록 썸네일도 워커가 만든 작은 이미지를 쓴다(큰 원본을 화면에서 디코딩하지 않음).
7. **셸·화면·엔진 분리**: 헤더/푸터는 셸(appHost.js, shell.css), 화면은 작업실(workspace.js) 자기 컨테이너만,
   처리 로직은 UI 없는 엔진(js/engines/). 엔진은 DOM·화면 상태를 모르고 `(file, options, ctx) → result` 만 한다.
8. **접근성/반응형**: 키보드 조작, `prefers-reduced-motion`, 모바일 폭(≤720px) 대응.
9. **아이콘은 `js/icons.js`의 16×16 픽셀 격자 SVG**('#' 칸 그림). 외부 아이콘 폰트 금지.

## 폴더 구조
```
index.html                    진입점 (셸 뼈대 + SEO 메타 + 하단 '서버 전송 없음' 안내) — 한국어
en/index.html  ja/index.html  영어·일본어 진입점 (같은 css·js 를 ../ 로, 소개글은 그 언어로 새로 쓴 HTML)
ads.txt                       AdSense 판매자 정보
css/theme.css                 테마 변수: 공통 토큰 + 테마 팩(landscape 낮/밤) + 갈무리 폰트 (← 색/간격 변경은 여기만)
css/scene.css                 배경 장면 레이어 구조 (하늘·구름·까치·별·별똥별·달·먼 산·먼 나무·안개·가까운 산·가까운 나무·땅·꽃잎/반딧불)
css/shell.css                 셸 레이아웃 + 공용 컨트롤(.btn .btn--icon .input .card ...)
css/page.css                  문서 페이지 공용 스타일
assets/themes/landscape/      배경 마스크 SVG (산 2겹·풀·흙·꽃잎, 합계 약 3KB)
css/apps/workspace.css        작업실 화면 스타일 (mount 시 <link> 로드)
js/main.js                    진입점 (i18n 사전을 기다리느라 DOMContentLoaded 뒤에 실행될 수 있어 readyState 확인)
js/i18n/                      화면 문구 사전: index.js(tx·setLang) · ko.js · en.js · ja.js
js/theme.js                   낮/밤 토글(localStorage 'ft-mode') + 배경 패럴랙스
js/moon.js                    밤하늘 달을 캔버스에 노이즈로 그리기 (로드 때 한 번)
js/magpie.js                  낮 하늘에 가끔 나는 갓 쓴 까치 (스프라이트 SVG 생성 + 비행·착지 단계 예약)
js/appHost.js                 앱 마운트 (셸). 헤더에 기능 탭 없음
js/appRegistry.js             앱 목록 — 작업실(workspace) 하나만 등록
js/icons.js                   인라인 SVG 아이콘
js/apps/workspace.js          ★ 작업실 화면: 통합 업로드 · 설정(왼쪽) · 목록(가운데) · 결과 확인(오른쪽) · 내보내기
js/apps/workspace/
  worker.js                   처리 워커 (한 번에 한 파일). options.engine 으로 엔진을 동적 import
  thumbWorker.js              사진 열어 보기(판별) + 썸네일 워커: 형식·크기·투명 영역·움직임, HEIC·TIFF 비교용 미리보기
                              (처리 워커와 별도라 긴 처리 중에도 썸네일이 바로 나옴). 못 열면 code 'unsupported'
js/engines/                   ★ UI 없는 처리 엔진 (워커 안에서만 import, DOM 사용 금지)
  imageCompress.js            compressImage(file, { mode, format, maxDim }, ctx)  사진 용량 줄이기
  imageResize.js              resizeImage(file, { method, ..., format, mode }, ctx) 비율·픽셀·목표 용량
  pdf/
    compress.js               compressPdf(file, { mode }, ctx)  (암호 확인 → 이미지 → 무손실 정리 → qpdf)
    libs.js                   pdf-lib(MIT) · qpdf-wasm(Apache-2.0/ISC) 지연 로더 (워커 전용)
    content.js                페이지 내용을 읽어 이미지가 그려지는 크기 계산 (읽기 전용)
    images.js                 PDF 속 이미지 찾기·풀기·다운샘플·재압축·교체
    preview.js                pdf.js(Apache-2.0)로 첫 페이지 그림 + 목록용 128px 썸네일 (화면 쪽에서 import, 지연 로딩)
  doc/                        문서 용량 줄이기 (워커 전용)
    compress.js               compressDoc(file, { mode }, ctx): 사진만 꺼내 compressImage(format 'same', 모드별 긴 변 2000/2560/그대로) → 제자리
    open.js                   형식 확인(확장자+시그니처) · 보안 문서 거르기 · 사진 목록. fflate(MIT) 지연 로딩
    zip.js                    ZIP 읽기 + 바뀐 항목만 다시 쓰기(나머지는 압축 바이트 그대로 복사, CRC 직접 계산)
    cfb.js                    복합 파일(HWP 5.0) 읽기·쓰기 직접 구현 — 디렉터리 항목 128바이트 원본 복사, 시작 섹터·크기만 새로
    probe.js                  올릴 때 썸네일 워커에서: 형식·보안·사진 수만
js/shared/                    공용 코드
  util.js                     loadCss, 용량 표기(formatBytes, changeText), renameExt
  limits.js                   ★ 업로드 한도·위험 계수 상수 (숫자는 여기서만 조정) + assess(file, kind)
  imageSize.js                사진 가로·세로를 파일 헤더만 읽어 구함 (JPEG SOF·PNG·WebP·GIF·BMP·ICO·AVIF/HEIC ispe·TIFF IFD)
  formats.js                  사진 저장 형식 규칙 (SAVEABLE·autoFormat·outputFormat·형식 이름) — 화면·워커 공용
  workerPool.js               모듈 워커 풀 (큐, abort, 충돌 시 재생성)
  image/                      ↓ 워커 안에서만 import
    workerHost.js             워커 메시지 처리 공통부: serve(processFile). err.notice=true 면 '안내'(오류 아님)
    pipeline.js               디코딩·고품질 축소·썸네일·화질 기준(TARGETS)·품질 탐색
    codecs.js                 jSquash WASM 코덱 로더 (jsDelivr)
    ssim.js                   화질 측정: SSIM + 블록 경계/얼룩 검사
    metadata.js               형식 판별(detectType: jpeg png webp gif bmp ico avif heic tiff, svg·psd 는 거절) · isAnimated
                              + 무손실 메타데이터 제거 (JPEG/PNG/WebP)
    decoders.js               브라우저가 못 여는 형식 전용 디코더 (지연 로딩): HEIC = libheif-js 1.19.8(LGPL, .mjs 별도 파일),
                              TIFF = UTIF.js 3.1.0(MIT) + pako 1.0.11(MIT) — 일반 스크립트라 받아서 실행. 회전값 반영
js/game/                      ★ 까치런(미니게임) — 헤더 [까치런] 버튼을 처음 누를 때만 import() (appHost.js)
  kachiRun.js                 화면: 입력(스페이스·↑·터치)·까치 고르기·그리기(인라인 SVG + transform)·착지 먼지·상태(대기/달리기/일시정지/끝)
  config.js                   ★ 숫자 모음(속도·점프·활강·간격·방패연·충돌·화면) — 한국어 주석. 조정은 여기서만
  rules.js                    규칙·물리 (DOM 없음, 고정 간격 1/120초, 칸 단위) — 노드에서 시뮬레이션 가능
  sprites.js                  칸 그림: 까치 두 마리는 magpie.js SPECIES 재사용(+ 갓·두루마리 조각, 펼쳐진 두루마리), 장독대·돌탑·짚단·방패연은 새로 그림
css/game.css                  까치런 스타일 (처음 열 때 불러옴). 색 = --magpie-* · --kr-*(theme.css, 밤엔 어둡게)
pages/                        about / features / privacy (애드센스 심사용)
robots.txt sitemap.xml        SEO
```

## 다국어 (ko / en / ja)
- 언어는 각 페이지의 `<html lang>`. `js/i18n/index.js` 가 최상위 await 로 그 사전을 불러 두고, 코드에서는 `tx('키', { 이름: 값 })`.
  사전 값 '{이름}' 에 값이 들어가고, 함수 값은 언어마다 규칙이 다른 표기(`fmt.mp` 화소 수 등).
- **JS 에 화면 문구를 직접 쓰지 말 것** — 새 문구는 ko.js·en.js·ja.js 세 사전에 같은 키로 넣는다(ko 는 원래 문구 그대로).
  키는 '파일 접두어.번호'(ws=workspace, cmp=imageCompress, rsz=imageResize, pdf, doc, docopen, zip, cfb, dec, pipe, lim …).
- 워커는 document 가 없어 처음엔 한국어 → WorkerPool 이 작업마다 `lang` 을 보내고 workerHost 가 `setLang` 후 처리.
  그래서 엔진에서는 모듈 최상위(불러올 때)에 tx() 문구를 만들면 안 된다 — 함수 안에서(예: pdf/compress 의 ENCRYPTED(), doc/open 의 NAME(ext)).
- 문구로 로직을 판단하지 말 것(번역되면 깨짐). 예: imageCompress 는 원본 유지 이유를 `reason` 값으로 따로 넘긴다.
- 페이지: 세 페이지 모두 hreflang(ko·en·ja·x-default→/), canonical·og:locale·JSON-LD inLanguage 를 그 언어로. 헤더 언어 전환 링크,
  자동 리디렉션 없음. 소개·기능·개인정보 페이지는 아직 한국어만 — en/ja 에서는 한국어 페이지로 링크(hreflang="ko").
  en/ja 소개글은 HWP·HWPX 를 언급하지 않는다(기능은 그대로 지원, 작업실 지원 형식 줄도 ws.fmtDoc 로 DOCX·PPTX·XLSX 만).
- 글꼴: Galmuri14 는 일본어 가나·한자를 모두 갖고 있지만 Galmuri11 Bold 에는 가나·한자가 하나도 없다 → 일본어 제목·라벨은
  --font-bold 다음 글꼴인 Galmuri14(굵지 않음, 12/24px 라 정수배 아님)로 대신 그려진다. ✓(U+2713)는 두 글꼴 모두 없음(시스템 글꼴).

## 작업실 동작 (workspace.js)
- 올리기 전 위험 계수(limits.js, 기준 기기 i5-6500/RAM 4GB): 사진 = 가로×세로×4×3 (헤더로 못 구하면 용량×12). PDF 는 파일 용량 그대로.
  한도 기본 사진 300MB(≈2,500만 화소)·PDF·문서 파일 80MB·목록 30개·300MB(파일 용량 합),
  navigator.deviceMemory ≥ 8 일 때만 600MB·150MB(PDF·문서)·50개·500MB. 단일 한도 초과 = 제외, 목록 한도는 올린 순서대로 넘치는 파일부터 제외.
  하나라도 제외되면 <dialog> 모달(.ws-modal, Esc·Enter 닫기, Tab 가둠) — 이유·해결 방법. 업로드 칸에 현재 한도 표시.
  index.html FAQ·features.html 의 한도 숫자는 정적 HTML 이므로 limits.js 를 바꾸면 함께 고칠 것.
  목록 썸네일은 항상 작은 별도 그림(사진: 썸네일 워커 128px WebP, PDF: 첫 페이지 그림에서 128px JPEG).
- 올리기: PDF(MIME·확장자)가 아니면 모두 사진 후보 → 썸네일 워커가 실제로 열어 본다(확장자 화이트리스트 없음).
  ① createImageBitmap(BMP·GIF 첫 장·ICO·AVIF 등 브라우저가 읽는 것 전부) ② HEIC·TIFF 는 decoders.js ③ JPG·WebP·AVIF 는 jSquash WASM.
  열기 전엔 '형식 확인 중'(적용 불가). 못 열면 목록에서 빼고 "이 형식은 아직 지원하지 않습니다 (지원: …)" 안내.
  SVG·PSD 는 거절. <img> 가 못 그리는 형식(HEIC·TIFF)은 워커가 비교용 미리보기(PNG, 8MP 초과는 JPG 0.95)를 만든다.
- 저장 형식: 원본 유지 / JPG / PNG / WebP / AVIF(이 브라우저가 AVIF 를 열 수 있을 때만 — 작은 AVIF 로 확인).
  원본 형식으로 저장 가능 = JPG·PNG·WebP(기본 원본 유지). 그 밖은 원본 유지 비활성 + 자동(formats.js autoFormat):
  BMP·TIFF·GIF·ICO → PNG, HEIC·AVIF → JPG(AVIF 는 PNG 로 바꾸면 몇 배로 커져서 HEIC 와 같이 JPG). 설정에 이유 한 줄.
  투명 영역이 있는 사진 + JPG 저장일 때만 '투명 배경 채우기 색'(기본 theme.css --jpg-fill-default). PNG 저장이면 용량 모드 비활성(무손실만).
  '원본보다 크면 원본 유지'는 저장 형식 = 원본 형식일 때만. 형식이 바뀌면(직접 선택·자동) 커져도 변환 결과 + '형식 변환으로 용량이 늘었습니다'.
  결과에 srcFormat·converted·filled(채운 색)·firstFrame(움직이는 이미지 첫 장면만)·grew 가 붙고, 목록에 'PNG → JPG' 표시.
- 설정은 **파일마다** 따로 보관(item.settings). [적용] = 선택한 파일 하나만 처리, 다시 적용하면 결과 덮어씀,
  [원본으로 되돌리기] = 결과 삭제. '같은 종류 전체에 이 설정 적용'은 보조 버튼(이미 같은 설정으로 끝난 파일은 건너뜀).
- 사진 설정 → 엔진: 크기 조정 '안 함'이면 compressImage, 그 외(비율·픽셀·목표 용량)는 resizeImage.
  출력 형식은 원본 유지 / JPG / WebP. 목표 용량 방식에서는 용량 모드를 쓰지 않는다(엔진의 TARGET_MODE).
- 처리 워커는 1개(한 번에 한 파일). 처리 중 다시 적용·삭제·되돌리기는 `pool.abort` 로 워커를 끊고 새로 시작.
- 결과는 메모리 Blob 으로만 보관. 덮어쓰기·되돌리기·삭제 때 object URL(결과·미리보기)을 반드시 revoke.
- 내보내기: 완료된 파일만 ZIP(fflate, level 0), 이름은 `원본이름_min.확장자`. 개별 다운로드도 가능.
  내보내지 않은 결과(원본 유지 제외)가 있으면 beforeunload 경고.
- 배치: 넓은 화면 설정|목록|결과, 중간 폭 설정|(목록/결과), ≤720px 목록→설정→결과.
- 업로드 칸은 하나(종류 자동 판별): 한 줄 안내 + '이 기기 기준' 한도 + 서버 전송 없음. 그 아래(칸 밖) 접이식 '지원 형식 보기'.
- 목록 필터 칩 [전체][사진][문서] — 보기만 바뀜. PDF·문서는 '문서'. 주소 #photo · #doc 로도 지정(history.replaceState).
  지금 필터에서 안 보이는 종류를 올리면 '전체'로, 고른 파일이 숨겨지면 보이는 첫 파일을 고른다.
- 문서(kind 'doc', 확장자 hwp·hwpx·docx·pptx·xlsx): 올릴 때 limits.js 가 시그니처(ZIP 'PK' / CFB D0CF11E0) 확인,
  썸네일 워커가 probe.js 로 사진 수·보안 확인 → 보안 문서는 목록에 '처리 불가'로 남고 적용 버튼 잠김.
  설정은 용량 모드만 + '문서 안 사진 N장'. 결과: 용량·감소율·줄인 사진 수 + 가장 큰 사진 하나 전후 비교(result.compare Blob),
  '결과 문서를 한글·오피스에서 열어 확인 · 원본은 따로 보관' 안내. 내보내기 이름 원본이름_min.(같은 확장자).

## 까치런 (미니게임, js/game/)
- 크롬 공룡 게임 오마주. 그림·이름은 독창적으로(공룡·선인장·익룡 모양·효과음을 흉내 내지 않음). 오마주 문구 = 사전 kr.003·kr.004, about 페이지, README.
- 열면 `<html data-game>` → .app-shell·광고(ins.adsbygoogle, .google-auto-placed) display:none, 하늘 까치는 visibility:hidden
  (display:none 이면 animationend 가 안 와서 magpie.js 단계가 멈춤). 작업실 DOM 은 그대로라 파일·압축이 이어진다. Esc·[작업실로 돌아가기]로 복귀(스크롤·포커스 복원).
- 칸 배율 4→3→2px 중 '최고 속도에서도 반응 시간 1.2초(가장 빠른 방패연 기준, VIEW.reactTime)'를 지키는 가장 큰 것
  (4 는 화면 높이 560px 이상만). 2px 로도 안 되면 그 폭에 맞춰 최고 속도를 낮춘다(rules.js speedCap — 360px 폰 약 103칸/초).
  발밑 = .scene__ground 위 + GRASS_SURFACE. **숫자는 모두 js/game/config.js**(한국어 주석):
  속도 90→198칸/초(0.825칸/초²), 점프 v0 170 · 중력 620(오르며 누르는 동안 300, 최대 0.22초) → 톡 약 25칸(장독대 두 개짜리도 넘음) / 꾹 약 38칸.
  내려오며 누르고 있으면 활강(낙하 14칸/초까지, 한 점프 0.6초). 공중 = magpie.js 날갯짓 4프레임, 활강 = 활강 프레임, 땅 = 서기↔깡총. 착지 먼지 3개.
  점수 = 거리×0.1, 150점·550점에 큰 장애물 단계, 350점부터 방패연: 자리마다 단독 연 10%(19·23칸 = 달리면 아래로 지나감)
  + '짧게 넘을 장애물 + 그 뒤 활강 높이(27칸) 연' 쌍 15% — 짧게 뛰고 착지하면 지나가고, 같은 때 활강하면 약 97% 걸린다.
  800점부터 쌍 25%, 단독 연 높이 19·23·27칸. 1200점에 게임 화면 안에서만 낮↔밤 한 번(<html data-mode> 만, ft-mode 저장값은 그대로,
  '다시' 안내·새 판·닫기 때 원래대로). 같은 땅 장애물은 최대 2번 연속(OBSTACLE.maxRepeat, 사이의 연은 셈에서 뺌).
  장애물 간격 ≥ 그 속도의 꾹 점프 거리(활강 없이, rules.js 가 config 로 계산) — 값을 바꾸면 노드로 봇을 돌려 끝까지 살아남는지 확인할 것.
- 까치 고르기(대기 화면 ◀ ▶ · ←/→): 갓 쓴 까치 / 선비 까치. 물리는 같고 판정 마스크는 각자 그림.
  부딪히면 갓 쓴 까치 = 갓(H·S)이, 선비 까치 = 두루마리(E·R·S)가 말림→반쯤→활짝(sprites.js SCROLL_HALF·OPEN) 펼쳐지며 뒤로 떨어진다. 0.9초 뒤 '다시'.
  고른 까치 'kachirun-bird', 최고 기록 'kachirun-best-gat'·'kachirun-best-seonbi'(옛 'kachirun-best' 는 갓 쓴 까치 기록으로 읽음).
- 판정은 칸 단위 마스크(갓 쓴 까치 그늘·갓끈, 꼬리 끝 4칸, 연줄 제외).
- WorkerPool.anyBusy() 면 30fps. visibilitychange·blur 면 일시정지. 모션 줄이기 = 대기 화면 안내(kr.009)만, 대기 깡총 애니메이션·착지 먼지 없음.
- localStorage 는 모두 try/catch. 루트 class 는 .kachirun (.kr 은 로고 SVG 칸 class 와 겹쳐서 쓰지 않음).
- 모바일 헤더: 둘째 줄 = [까치런] … [언어 전환] (.app-header::after 로 줄바꿈, row-gap 0).

## 사진 압축 파이프라인 요약 (engines/imageCompress.js)
1. 형식 판별 → 메타데이터 무손실 제거 (후보 A)
2. `createImageBitmap(imageOrientation: 'from-image')`로 디코딩 (회전 반영), 필요하면 해상도 축소
3. 출력 형식별 처리
   - PNG 유지: oxipng 무손실 최적화 (후보 B)
   - JPG/WebP/AVIF: 품질 이분 탐색 → 기준을 통과하는 가장 낮은 품질 (후보 C)
     큰 사진은 256px 타일 모자이크(약 1.6MP)로 탐색 후 전체 이미지로 최종 검증
4. 후보 중 가장 작은 것. 원본보다 작지 않으면 원본 유지
5. 저장 형식이 원본과 다르면 1~4 대신 convertImage: 디코딩 → (JPG 면 투명 부분 배경색) → PNG 무손실 /
   손실 형식은 품질 탐색(기준 통과 품질 없으면 최고 품질). 원본보다 커도 결과를 돌려준다.

## 사진 크기 조절 요약 (engines/imageResize.js)
- 비율·픽셀: 원본 크기를 넘지 않게 계산 → `resizeTo`(절반씩 단계 축소) → 화질 기준(작업실의 용량 모드,
  없으면 `balanced`)을 통과하는 가장 작은 품질로 저장. 같은 형식인데 원본보다 커지면 원본 용량 아래로 품질을 맞춘다.
  비율 유지 + 가로·세로 둘 다 입력 = 그 칸 안에 맞춤(프리셋 버튼은 가로=세로=N 으로 '긴 변 N').
- 목표 용량: 원래 형식이고 이미 목표 이하면 그대로. 아니면 배율 s=1 에서 시작해
  ① 목표 이하가 되는 가장 높은 품질(`fitUnder`) → ② 화질 기준 `size` 통과 시 채택,
  실패하면 기준 품질(REF_Q)의 용량으로 다음 배율을 어림해 줄임 → ③ 채택 후 실패 배율과의
  사이를 최대 3번 더 좁혀 가장 큰 해상도를 고름. 긴 변 640px 이하에서는 기준 미달이어도 채택(경고 표시).
  PNG 유지 시에는 무손실이라 해상도만 줄인다. 목표 바이트는 1KB=1000B 로 계산(제출처 기준보다 작게).
- 결과는 항상 실제 바이트 수로 목표 이하인지 확인한 것만 돌려준다.

## 문서 용량 줄이기 요약 (engines/doc/compress.js)
- 사진 위치: HWPX `BinData/` · DOCX `word/media/` · PPTX `ppt/media/` · XLSX `xl/media/` (ZIP), HWP 5.0 BinData 스토리지(CFB).
- HWP FileHeader 속성 비트: 1 암호 · 2 배포용 · 4·10 DRM · 7 전자 서명 · 8 공인인증서 암호화 → 안내(notice) 후 처리 안 함.
  암호 건 DOCX·PPTX·XLSX 는 CFB(EncryptedPackage), HWPX 암호는 META-INF/manifest.xml 의 암호 정보, 서명은 _xmlsignatures·META-INF/signatures.
  HWP BinData 스트림은 raw deflate 를 풀어 보고 사진이면 '압축됨' → 다시 같은 방식으로 압축해 넣는다.
- 사진 규칙: JPG·PNG 만, 같은 형식으로만. 결과가 원본보다 작을 때만 교체. 회전값 있는 JPG·CMYK JPG·GIF·BMP·EMF·WMF·SVG 는 그대로.
  한 장씩 처리·해제. 문서 전체가 3% 미만으로 줄면 원본 유지 + '줄일 사진이 거의 없는 문서입니다'.
- ZIP: 바뀐 항목만 새 로컬 헤더(데이터 설명자 비트 끔)·CRC·크기, 중앙 디렉터리는 원본 레코드 복사 후 오프셋만. HWPX mimetype 은 첫 항목·STORE(원본이 압축이었어도).
- CFB: 버전·섹터 크기 원본 따름, 4096 미만 스트림은 미니 스트림. 범용 cfb 라이브러리는 쓸 때 임시 스트림을 덧붙여 직접 구현.
- 검증 방법(테스트): 항목 이름·순서 동일, 사진 아닌 항목 바이트 동일, 바뀐 사진 같은 형식·같은 비율, HWP 디렉터리 항목(트리·색·CLSID·시간) 동일.

## PDF 용량 줄이기 요약 (engines/pdf/compress.js)
1. 암호(보안) PDF는 사용자 암호든 권한 암호든 처리하지 않고 안내 문구로 끝낸다(오류 아님 — `notice` 로 던져 목록에 "처리 불가").
   pdf-lib 가 못 여는 손상 파일은 qpdf 로 복구한 뒤 다시 연다.
2. 이미지 재압축(images.js): 이미지 XObject 중 DCT(JPEG)·Flate 8비트, RGB/Gray(ICCBased 포함)만.
   CMYK·Indexed·특수 색공간·Decode 배열·색 키 마스크·JBIG2/CCITT/JPX·SMask 로 쓰이는 이미지는 그대로.
   content.js 가 잰 표시 크기 기준 ppi 가 모드 목표(150/200/300)의 1.5배를 넘으면 다운샘플.
   공용 `searchQuality`(MozJPEG + SSIM)로 저장하고, 5% 이상 줄 때만 교체. DeviceRGB 인데 무채색이면 흑백 JPEG.
   ※ 교체 직전 새 JPEG 의 성분 수(1/3)가 PDF 색공간과 맞는지 반드시 확인한다(어긋나면 그림이 깨짐).
3. 무손실 정리: 내용이 똑같은 스트림 합치기(폰트·이미지 중복), PieceInfo·Thumb·XMP 제거(PDF/A 는 XMP 유지).
4. qpdf: `--object-streams=generate --recompress-flate --compression-level=9 --remove-unreferenced-resources=yes`.
   qpdf 실패 시 pdf-lib 저장으로 대체. 결과를 다시 열어 쪽수가 다르면 원본에 qpdf 무손실만 적용.
5. 3% 미만으로 줄면 원본 유지 + "이미 최적화된 PDF입니다".
- qpdf-wasm 글루(qpdf.js)는 CommonJS 라 module 워커에서 import 불가 → libs.js 가 받아서 실행하고,
  .wasm 은 한 번 받아 blob 주소로 `locateFile` 에 넘긴다(이 빌드는 locateFile 만 받음).
- 미리보기·목록 썸네일은 pdf.js 를 화면 쪽에서 한 장씩 차례로 그린다(문서 해석은 pdf.js 자체 워커). PDF 를 처음 올릴 때만 불러온다.
- 글꼴 서브셋(안 쓰는 글자 빼기)은 하지 않는다 — 글자를 다루는 일이라 위험 대비 이득이 작다.

### 화질 기준 조정 시 주의
- 품질 탐색(searchQuality): 큰 사진은 모자이크로 찾고 전체 이미지로 검증 — +4씩 세 번 실패하면 남은 범위를 전체 이미지로 이분 탐색(포기하지 않음).
- 기준값은 `js/shared/image/pipeline.js`의 `TARGETS` (사진 두 앱과 PDF 앱이 같이 씀). 2.5MP 초과 사진은 SSIM을 절반 해상도로 잰다(`large`).
- SSIM만으로는 매끈한 그라데이션의 계단·얼룩을 못 잡는다. 그래서 `ssim.js`의 `blockiness`가 있다.
  이를 빼거나 완화하면 하늘/어두운 배경 사진이 망가진다(실제로 확인됨).
- 값을 바꾸면 반드시: 그라데이션 사진, 텍스처 많은 사진, 노이즈 많은 큰 사진, 이미 압축된 사진으로
  JPG/WebP/AVIF 각각 결과를 100% 확대해 눈으로 확인.

### 코덱(CDN) 관련
- jSquash 래퍼(`encode.js`)는 `wasm-feature-detect` bare import 때문에 CDN에서 직접 못 쓴다.
  그래서 `codecs.js`는 `codec/enc/*.js` 글루 파일을 직접 import 한다.
- 위치: `js/shared/image/codecs.js`. 버전을 올릴 땐 `V`와 각 모듈의 `encode()` 인자/기본 옵션(meta.js)을 함께 확인.
- AVIF 멀티스레드 버전은 cross-origin isolation이 필요해 쓰지 않는다(단일 스레드).

## ★ 새 기능 추가 방법 (작업실에 넣는다)
기능 탭은 없다. 새 기능은 작업실 안에 "엔진 + 설정"으로 추가한다.
1. **엔진**: `js/engines/<기능>.js` 에 `export async function run(file, options, ctx) → result` 작성.
   - UI·DOM 금지(워커 안에서 돈다). 진행은 `ctx.progress(label, 0~1)`.
   - result: `{ kind: 'lossy'|'lossless'|'stripped'|'original', bytes?, size, mime, ext, note?, warn?, width?, height?, pages? }`
     (`kind: 'original'` 이면 bytes 없이 원본 유지). 처리할 수 없는 파일 안내는 `Object.assign(new Error(msg), { notice: true })`.
   - 사진 디코딩·인코딩·화질 측정은 `js/shared/image/pipeline.js` 를 import.
2. **워커 등록**: `js/apps/workspace/worker.js` 의 `ENGINES` 에 `이름: () => import(...)` 한 줄 (동적 import = 지연 로딩).
3. **화면**:
   - 새 파일 종류라면 `workspace.js` 의 `KINDS`(mimes·ext·label·icon)와 `ACCEPT`, `DEFAULTS` 추가.
   - 설정 패널은 template 의 `.ws-set[data-kind=...]` + fill/read 함수, `toOptions()` 에서 `engine` 이름 지정.
   - 미리보기는 `getPreview()`.
   - 스타일은 `css/apps/workspace.css` (theme.css 변수만).
4. `pages/features.html`, `sitemap.xml`(lastmod), 필요 시 `index.html` 메타 설명 갱신.

## 디자인 테마 (모던 픽셀 아트)
- `<html data-theme="landscape" data-mode="day|night">`. 모드는 각 HTML `<head>` 의 짧은 스크립트가 그리기 전에 정한다
  (저장값 → 없으면 prefers-color-scheme). 헤더 토글은 `js/theme.js`.
- **새 테마 팩**(예: neon): theme.css 에 `[data-theme="neon"]` 낮 변수 + `[data-theme="neon"][data-mode="night"]` 밤 변수,
  `assets/themes/neon/` 에 마스크 SVG 를 넣고 `--scene-*-mask` 로 가리키면 끝. 컴포넌트 CSS 는 손대지 않는다.
  소품(지금은 벚꽃나무)은 3톤 마스크 `--scene-prop-{a,b,c}-mask` + 색 `--scene-prop-{a,b,c}`, 별은 타일 4장
  `--scene-star-mask-1~4`/`--scene-star-tile-1~4`(1 고정, 2~4 반짝임), 별똥별 `--scene-meteor-mask` — 모두 theme.css 의 인라인 SVG.
  하늘: 낮 묶음 `.scene__day`(구름 3종 `--scene-cloud-{1,2,3}-mask`/`-shade-mask`, 해 없음)와
  밤 묶음 `.scene__night`(별·별똥별·달). 토글하면 두 묶음이 0.4초 4단계로 교차 페이드.
  달은 `<html data-moon="full|crescent">` — 각 HTML `<head>` 스크립트가 열 때마다 50:50 으로 고르고,
  `js/moon.js` 가 56×56 칸 캔버스(달 지름 40칸)에 고정 시드 값 노이즈(얼룩)·바다 덩어리·왼쪽 위 하이라이트·가장자리 어둡게를
  계산해 `--moon-*` 7톤으로 양자화하고, 테두리 빛 한 줄과 원형 계단 빛 번짐 링 3겹(0.16/0.08/0.04, 초승달은 더 약하게)까지
  한 번 그린다. 초승달은 저녁 초승달 방향 — 밝은 쪽 오른쪽 아래, 명암 경계가 세로에서 40°(moon.js TILT),
  어두운 쪽은 완전히 투명, 빛 번짐은 밝은 부분에서의 거리로만(둥근 원판 윤곽이 안 보이게), 뿔 끝 외톨이 칸 제거,
  오목한 안쪽(왼쪽 위)에 작은 별 3개(CRESCENT_STARS). --orb 에 따라 2배/1배 pixelated 확대.
  별 레이어는 달 둘레(달 칸 크기의 0.52배 반지름)를 비운다.
  빈 마스크가 필요하면 `none` 이 아니라 빈 SVG(`none` 은 칸 전체가 칠해짐).
  달 위치(scene.css `--orb-*`): 콘텐츠(`--shell-max`) 바깥 오른쪽 빈 여백의 가운데. 여백이 112px 보다 좁으면(약 1580px 미만)
  56px(캔버스 1배)로 줄이고 화면 밖으로는 나가지 않게 한다. 1366px 이하는 여백이 거의 없어 카드 뒤에 가려진다.
- 배경 개수: 꽃잎 데스크톱 16 · 태블릿 11 · 모바일 6(뒤쪽 작고 옅게, 앞쪽 크고 빠르게, 2개는 나무에서 흩날림),
  밤 별 약 50 / 모바일 약 12, 반딧불은 땅 근처 8개 이하, 나무 4그루 / 모바일 2그루, 구름 9개 / 모바일 5개 — 화면 위 8% ~ 먼 산 능선 바로 위(최대 60%)에 12% 간격, 위쪽은 크고 진하고 빠르게·아래쪽(산 근처)은 작고 옅고 느리게.
  까치 두 마리(낮 전용, `js/magpie.js` 의 SPECIES): gat = 갓 쓴 까치, seonbi = 선비 까치(로고와 같은 디자인, 흑립 반투명 챙·
  호박 구슬·파란색 없음·두루마리를 모든 프레임에서 묾, 쪼기 없음, 날갯짓 --flap .84s·완만하고 긴 활강, 들어온 반대편 여백에 착지).
  각자 따로 예약(첫 비행 3~5초 / 11~13초 시차). 착지 자리(왼쪽·오른쪽 여백)는 spots 로 예약해 같은 쪽에 둘이 앉지 않는다.
  선비 까치 색은 브랜드 변수(--kachi-*·--inju·--hobak·--hanji). 아래는 갓 쓴 까치 기준 설명.
  갓 쓴 까치: 24×16 칸 오리지널 스프라이트 8프레임 띠(날갯짓 4 · 활강 · 서기 · 쪼기 · 깡총,
  프레임 사이 빈 칸 1줄). 검은 머리·등·긴 꼬리, 흰 배, 날개 푸른 광택, 갓 = 넓은 챙·높은 대우·갓끈. 색은 `--magpie-*`.
  땅 앞에 서야 해서 `.scene` 안 `.scene__fx` 바로 앞에 JS 가 끼운다(구름·산보다 앞, 카드 뒤).
  움직임은 단계(phase) 연속: 단계마다 좌표(--ax/--ay → --bx/--by)·동작(data-act)을 정하고 CSS 애니메이션 한 번 →
  animationend 에서 다음 단계(그래서 탭이 숨으면 같이 멈춤). 20~40초(모바일 40~80초)에 한 번 한 마리, 방향·높이·속도 랜덤.
  약 1/3 은 착지: 날아옴 → 활강 → 카드 바깥 양옆 여백(달 자리와 같은 계산) 풀밭 → 3~6초(깡총·쪼기·뒤돌아보기 중 1~2개)
  → 빠르게 퍼덕이며 날아올라 화면 밖. 발 밑 = 땅 띠 위 + 20px(grass.svg 의 빈틈없는 5줄째 × 4px, `GRASS_SURFACE`) —
  풀 마스크를 바꾸면 이 값도 바꿀 것. 여백이 까치 폭+8px 보다 좁으면(약 1520px 미만, 태블릿·모바일) 착지 없이 지나가기만.
  밤 모드에선 만들지도 날지도 않고, 날던·앉아 있던 중 밤이 되면 즉시 사라진다(display:none + 단계 취소). 모션 줄이기도 표시 안 함.
  테스트용: 첫 비행은 로드 3~5초 뒤(`FIRST_MS`), 착지 비행(`FIRST_LANDS`). 배경은 transform·opacity 애니메이션만,배경은 transform·opacity 애니메이션만,
  탭이 숨겨지면 `.scene[data-paused]` 로 정지.
- 로고(index.html 헤더, shell.css .brand): 까치 아이콘은 16×16 칸 SVG(칸마다 class → --kachi-ink·--kachi-cream·--hobak·--inju·
  --kachi-gray·--hanji·--hanji-edge, 챙은 fill-opacity .45) 32px(모바일 16px). 밤엔 --kachi-outline 연보라 외곽선(drop-shadow 4방향, 한 칸 두께).
  SLIM 배지 = --brand-badge(낮 --inju, 밤 --inju-night) 바탕 + --kachi-cream 글자 + 픽셀 테두리, Kachi = Galmuri11 Bold 24px(모바일 12px).
  배지 글자 대비는 밤에 4.5:1 아래지만 로고 글자라 WCAG 대비 예외.
- 폰트: 갈무리(OFL) jsdelivr `galmuri@2.40.3` — Galmuri14(본문 15px) + Galmuri11 Bold(라벨 12px·제목 24px)만.
  **설계 크기의 정수배(15 / 12·24)로만** 크기를 지정(그 밖은 번짐). Galmuri14 는 굵은체가 없어 `font-synthesis: none`,
  굵게 보일 곳은 `--font-bold` + 12/24px. 일반 Galmuri11(505KB)은 받지 않는다.
- 픽셀 테두리: border 대신 네 방향 box-shadow(`--bw` 두께, `--bc` 색) + `--drop`(딱딱한 그림자, `--shadow-pixel`).
  모서리가 한 칸 깎여 계단 모양. `--drop` 에 `none` 을 넣지 말 것(그림자 전체가 무효) — 없앨 땐 `0 0 0 0 transparent`.
- 간격은 4px 격자(`--px: 4px`). 둥근 모서리 없음.
- 애니메이션은 `steps()` 로 한 칸씩: 업로드 점선 흐름, 진행 게이지(20칸, workspace.js `gauge()` 가 5% 단위로 끊음),
  처리 중 파일 아이콘 축소(`ws-squish`), 완료 감소율 반짝임(`ws-sparkle`). `prefers-reduced-motion` 이면 전부 정지.
- 글은 항상 카드 위(헤더·푸터·소개도 카드). 장면은 z-index:-1 고정 배경. 광고 자리(`ins.adsbygoogle`)는 장식 없음.
- 색 대비 WCAG AA 이상 — 색을 바꾸면 글자/바탕 쌍의 대비(4.5:1)를 다시 계산할 것.

## 로컬 실행
ES 모듈·워커라 `file://` 직접 열기는 동작 안 함. 정적 서버로 실행:
```bash
python -m http.server 5500     # → http://localhost:5500
```

## 배포 (Cloudflare Pages)
- 빌드 명령: 없음 / 출력 디렉터리: `/`
- GitHub 저장소 연결 후 push 하면 자동 배포.

## 배포 전 체크리스트
- [ ] `slimkachi.pages.dev` → 실제 배포 주소로 전부 치환
      (index.html의 canonical·og:url·og:image·JSON-LD url, pages/*.html canonical, sitemap.xml, robots.txt)
- [ ] `ads.txt`가 루트에서 열리는지 확인 (`https://<주소>/ads.txt`)
- [ ] AdSense 스크립트 client id(`ca-pub-1007112926199900`)가 ads.txt의 pub id와 일치
- [x] `assets/og-image.png`(1200×630, 낮 배경 + 로고 + 문구)·`favicon.svg`·`favicon.ico`(16·32·48·64) SlimKachi 로 교체 완료
      (로고를 바꾸면 세 파일도 다시 만들 것 — 색값은 theme.css 브랜드 변수와 맞춘다)
- [ ] privacy.html 최종 수정일·문의 이메일 확인
- [ ] 브라우저 개발자 도구 Network 탭에서 사진 처리 중 **사용자 파일이 전송되는 요청이 없는지** 확인
      (보여야 하는 것: jsdelivr 코덱 .js/.wasm, 광고 스크립트뿐)
- [ ] 실제 기기 확인(작업실): 사진·PDF 섞어 올리기, 파일 선택 시 설정 전환, 적용·다시 적용·되돌리기,
      10MB 이상 사진(화면 안 멈춤), 이미 작은 사진(원본 유지), 비교 슬라이더, 전체 내보내기 ZIP(완료 파일만),
      내보내기 전 새로고침 경고, 모바일 화면(목록→설정→결과 순서)
- [ ] 크기 조절: 비율·픽셀·목표 용량 세 방식, 목표 용량 결과 파일이 실제로 목표 이하인지(탐색기 속성의 바이트 수)
- [ ] PDF: 스캔본·사진 많은 PDF·글자 위주 PDF로 감소율 확인, 결과 PDF에서 글자 선택·검색(Ctrl+F),
      암호 PDF 안내 문구, 사진만 올렸을 때 pdf-lib·pdf.js·qpdf·engines/pdf 를 내려받지 않는지(Network 탭)
- [ ] 문서: 사진 많은 HWP·HWPX·DOCX·PPTX·XLSX 결과를 실제 한글·오피스에서 열어 확인, 암호·배포용 HWP·암호 DOCX 안내, 사진 없는 문서 원본 유지
- [ ] 업로드 한도: 4,800만 화소 사진(제외)·2,400만(추가)·200MB PDF(제외)·40장(30장만)·25장+10장(5장만), 팝업 키보드 조작
- [ ] 형식: BMP(→PNG 감소), 움직이는 GIF(첫 장면 안내), 아이폰 HEIC(→JPG), TIFF(회전 포함), AVIF, PSD·SVG·문서(지원 안 함 안내),
      투명 PNG→JPG(배경색·안내), JPG→PNG(용량 증가 안내), 내보내기 파일명 확장자, HEIC·TIFF 를 넣을 때만 libheif·utif·pako 를 받는지(Network)
- [ ] 다국어: /en/·/ja/ 에서 화면에 한국어가 남지 않는지(언어 전환 '한국어' 링크 제외), hreflang·sitemap(xhtml:link) 확인
- [ ] 새 기능 추가 시 features.html·sitemap.xml 갱신 (+ en/ja 소개글, 세 사전)
