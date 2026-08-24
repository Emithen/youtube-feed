// oauth-config.ts — **화면과 서버가 같이 읽는 상수.** 브라우저 의존성이 없어야 한다.
//
// ⭐ 왜 이 파일이 따로 있나: 2026-08-25에 인증이 Authorization Code flow로 가면서
//  `CLIENT_ID`가 **두 곳에서 필요해졌다** — 화면은 code를 요청할 때, 서버는 code를 교환하고
//  ID 토큰의 `aud`를 검사할 때. 각자 적어두면 어긋날 수 있는데, **어긋나면 증상이
//  `aud` 불일치로 나와서 진단이 엉뚱한 데로 간다**(값이 틀린 게 아니라 "인증이 안 된다"로 보인다).
//  → 한 곳에서 읽게 해서 어긋날 자리를 없앤다.
//
// ⚠️ **여기에 브라우저 것(`window`·`localStorage`·DOM 타입)을 넣으면 안 된다.**
//  `api/`는 Node 런타임이라 그 순간 서버가 import를 못 한다. `youtube.ts`를 서버가 그대로
//  가져다 쓸 수 없는 이유가 정확히 그것이고, 그래서 상수만 이리로 뽑아냈다.

// Google Cloud Console에서 만든 OAuth 클라이언트 ID.
// ⭐ **비밀이 아니다** — 승인된 원본/리디렉션 URI로 도메인이 제한되므로 공개 저장소에 있어도 된다.
//  비밀인 것은 `GOOGLE_CLIENT_SECRET`이고 그건 서버 환경변수에만 있다(`.env.example`).
// ⚠️ 앞의 숫자가 그대로 클라우드 프로젝트 번호다(`60100393090`). 콘솔에서 헤맬 땐 이걸로 맞춘다.
export const CLIENT_ID =
  "60100393090-r2g4ml40ov9tkmjh2en99v1q3fasgafb.apps.googleusercontent.com";

// 서버 API가 받아주는 출처. **화면은 이 목록을 쓰지 않는다** — 서버 쪽 방어인데도 여기 둔 이유는
// `api/` 안에서 파일을 나누면 Vercel이 그걸 함수로 오해할 수 있어서다(`api/*`는 곧 엔드포인트다).
//
// ⚠️ 인증에서는 이 목록이 **방어 이상의 역할**을 한다. 팝업 모드의 `redirect_uri`는
//  「호출한 페이지의 origin」인데, 서버는 그 값을 요청의 `Origin` 헤더에서 읽는다.
//  즉 **이 목록에 없는 origin은 교환 자체가 불가능**하다 — 아무 값이나 redirect_uri로
//  보내지 못하게 막는 것이 이 목록이다.
export const ALLOWED_ORIGINS = [
  "https://youtube-feed-mu.vercel.app",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
];
