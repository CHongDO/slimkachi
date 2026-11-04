# SlimKachi (슬림까치) — 사진·PDF·문서 용량 줄이기 (file-tool)

파일을 서버로 보내지 않고 **브라우저 안에서만** 용량을 줄이는 정적 웹 도구.
한 화면(작업실)에서 사진과 PDF를 섞어 올리고, 파일마다 설정해 적용한 뒤 ZIP으로 내보낸다.
- 사진: 용량 줄이기 (MozJPEG / WebP / 무손실 PNG, 화질 측정으로 자동 품질 결정)
  + 크기 조정 (비율 / 픽셀 / 목표 용량 — "500KB 이하" 같은 제출 용량 자동 맞춤)
- PDF: PDF 속 사진만 재압축·다운샘플 + qpdf 무손실 정리 (글자 선택·검색 유지)

## 빠른 시작 (로컬 실행)
ES 모듈 + Web Worker를 쓰므로 파일을 직접 열지 말고 정적 서버로 실행한다.

```bash
python -m http.server 5500
# 브라우저에서 http://localhost:5500
```
또는 VS Code **Live Server** 확장.

## 구조 한눈에
- `css/theme.css` — 테마 변수. **색/간격을 바꾸려면 여기만 수정.**
- `css/shell.css` — 헤더/푸터 레이아웃 + 공용 컨트롤
- `js/appHost.js`, `js/appRegistry.js` — 셸이 작업실 화면을 붙인다
- `js/apps/workspace.js` + `css/apps/workspace.css` — **작업실 화면** (업로드·설정·목록·결과·내보내기)
- `js/apps/workspace/worker.js` — 처리 워커 (한 번에 한 파일, 엔진을 필요할 때만 불러옴)
- `js/engines/` — **UI 없는 처리 엔진**: `imageCompress.js`, `imageResize.js`, `pdf/`(pdf-lib · qpdf · pdf.js, CDN 지연 로딩)
- `js/shared/` — 워커 풀, `image/`(코덱 로더·화질 측정·메타데이터 제거·디코딩/품질 탐색 파이프라인)
- `pages/` — 소개 / 기능 / 개인정보처리방침 (애드센스용)

작업 규칙과 새 기능 추가 방법은 `CLAUDE.md` 참고.

## 배포
Cloudflare Pages에 GitHub 저장소 연결(빌드 명령 없음, 출력 `/`).
push 시 자동 배포. 배포 전 `CLAUDE.md` 체크리스트 확인.
