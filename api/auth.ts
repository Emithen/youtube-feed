// api/auth.ts — 구글 로그인의 마지막 한 걸음. **서버가 "이 요청이 누구인지"를 처음 판단하는 곳.**
//
// 브라우저는 팝업에서 **인가 코드(code)만** 받아 이리로 보낸다. 코드를 토큰으로 바꾸는 일은
// 서버가 한다 — `client_secret`이 필요하고, 그건 브라우저에 둘 수 없기 때문이다.
// 왜 이 흐름인지(액세스 토큰 introspection을 왜 안 골랐는지 포함)는
// ROADMAP.md의 «🔐 인증 설계 확정 (2026-08-25)»에 근거까지 적어뒀다.
//
// ── 계약 ──
//  POST   /api/auth   { code: "4/0Ab..." }
//  → 200 { accessToken, expiresIn }  + Set-Cookie: sid=…  (HttpOnly)
//
//  DELETE /api/auth   (로그아웃)
//  → 204  + Set-Cookie: sid=; Max-Age=0
//  ⭐ **로컬 토큰만 지우면 안 된다.** 서버 세션이 살아 있으면 같은 브라우저를 쓰는 다음 사람이
//   여전히 내 데이터에 접근한다. 로그아웃은 **양쪽을 다 끄는 것**이어야 한다.
//
//   400  code가 없거나 JSON이 아니다
//   401  구글이 코드를 거절했다(만료·재사용·위조) 또는 ID 토큰 검사 실패
//   403  허용되지 않은 출처
//   500  서버 설정(환경변수)·DB 장애
//  ⭐ 판정만 넘기고 한국어 문장은 화면이 만든다 — feedback.ts·worker.ts와 같은 경계다.
//
// ── ⭐ 왜 ID 토큰 서명을 검증하지 않는가 ──
//  구글 문서: *"since you are communicating directly with Google over an intermediary-free
//  HTTPS channel and using your client secret to authenticate yourself to Google, you can be
//  confident that the token you receive really comes from Google and is valid."*
//  → 이 토큰은 **우리 서버가 구글에서 직접** 받아온 것이다. 중간에 아무도 없다. 그래서
//    JWKS도 검증 라이브러리도 필요 없다. **단 `iss`·`aud`·`exp`는 반드시 본다**(아래).
//
//  ⛔ **그 면제에는 조건이 붙는다.** 같은 문서: *"if your server passes the ID token to other
//   components of your app, it is extremely important that the other components validate the
//   token before using it."* → 이 파일은 ID 토큰을 **아무 데도 넘기지 않는다.** `sub`만 꺼내고
//   그 자리에서 버린다. **이 설계를 유지하는 것이 면제의 조건이다** — 언젠가 이 토큰을 밖으로
//   내보내고 싶어지면, 그때는 서명 검증을 먼저 붙여야 한다.
//
// ⚠️ **refresh 토큰은 받아서 버린다** (2026-08-25 결정). 버그가 아니다.
//  GIS의 `initCodeClient`에는 이걸 끄는 파라미터(`access_type`)가 아예 없어서 **안 받을 방법이
//  없다.** 저장하지 않는 이유는 db/002_auth.sql에 적어뒀다 — 요약하면, 저장해서 사는 것은
//  「로그인 버튼이 1시간마다 → 7일마다」뿐인데 값은 「만료 없다시피 한 상시 접근 권한 보관」이다.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes } from "node:crypto";
// ⚠️ **확장자는 `.js`다. 오타가 아니다.** `api/`는 `moduleResolution: nodenext`라 상대 경로에
//  **출력 확장자**를 적어야 한다(`src/`는 bundler 모드라 확장자를 안 쓴다 — 그래서 두 폴더의
//  import 모양이 다르다). Vercel이 `oauth-config.ts`를 `oauth-config.js`로 컴파일해 함수에
//  같이 넣어주고, **import 문자열은 안 고친다** — 그래서 `.js`를 가리켜야 맞는다.
//
//  ⛔ **`.ts`로 바꾸지 마라.** 2026-08-25에 실제로 그렇게 했다가 배포가 죽었다
//   (`ERR_MODULE_NOT_FOUND: /var/task/src/lib/oauth-config.ts`). 바꾼 이유는 «로컬에서
//   `node api/auth.ts`가 안 돈다»였는데, **bare node는 애초에 배포 환경이 아니다** —
//   Vercel이 하는 컴파일을 안 하니 당연히 다르다. 확인하려면 `npx vercel build` 후
//   `.vercel/output/functions/api/auth.func/`를 본다. 그게 실제로 배포되는 물건이다.
import { ALLOWED_ORIGINS, CLIENT_ID } from "../src/lib/oauth-config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

// 구글이 ID 토큰에 적는 발급자. 두 표기가 다 쓰인다(역사적 이유). 둘 다 받아준다.
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const COOKIE = "sid";
const SESSION_DAYS = 30; // 슬라이딩. 짧게 잡을 이유가 없다 — 만료돼도 앱 재로그인일 뿐이다

// ⚠️ 로그인과 로그아웃이 **같은 속성으로** 쿠키를 써야 한다. 하나라도 다르면(특히 Path)
//  브라우저가 다른 쿠키로 보고 **지우기가 조용히 실패한다** — 그래서 한 함수에서 만든다.
// ⚠️ `Secure`는 https일 때만. 로컬은 `http://localhost:8765`인데 브라우저마다 localhost를
//  보안 컨텍스트로 봐주는 정도가 달라서, 무조건 붙이면 **로컬에서만 쿠키가 조용히 안 잡힌다.**
// ⭐ `SameSite=Lax`로 CSRF를 막는다. API가 `/api/*`로 **같은 origin**이라 깔끔하게 듣는다 —
//  08-17 Vercel 이전으로 공짜로 생긴 이점이다(그전엔 화면과 서버가 다른 곳에 있었다).
function cookie(origin: string, value: string, maxAgeSec: number) {
  return [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(origin.startsWith("https://") ? ["Secure"] : []),
    `Max-Age=${maxAgeSec}`,
  ].join("; ");
}

// 구글이 코드를 내주는 응답. 쓰는 것만 적는다.
type TokenExchange = {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string; // ⚠️ 받기만 하고 안 쓴다 (위 주석)
  scope?: string;
  error?: string;
  error_description?: string;
};

// ID 토큰에서 우리가 보는 것 전부. 나머지 클레임(email·name·picture)은 **일부러 안 읽는다** —
// 안 읽으면 실수로 저장할 일도 없다.
type IdClaims = { iss?: string; aud?: string; exp?: number; sub?: string };

// ⭐ 서명은 안 보지만 **내용은 본다.** 이 셋을 빼먹으면 검증을 안 한 것과 같다.
//  특히 `aud`: 이게 없으면 «다른 앱에 발급된 토큰»도 통과한다 — ROADMAP에 적어둔
//  bearer 토큰 대체 공격이 정확히 그 구멍을 노린다.
function readIdToken(jwt: string): string {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("ID 토큰 모양이 아니다");

  let c: IdClaims;
  try {
    c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as IdClaims;
  } catch {
    throw new Error("ID 토큰 페이로드를 못 읽었다");
  }

  if (!c.iss || !ISSUERS.includes(c.iss)) throw new Error("발급자가 구글이 아니다");
  if (c.aud !== CLIENT_ID) throw new Error("이 앱에 발급된 토큰이 아니다"); // ⛔ 빼면 안 된다
  if (!c.exp || c.exp * 1000 <= Date.now()) throw new Error("만료된 토큰이다");
  if (!c.sub) throw new Error("sub가 없다");

  return c.sub;
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

// 쿠키 헤더에서 sid만 꺼낸다. ⚠️ 값에 `=`가 들어갈 수 있어(base64url엔 없지만) 첫 `=`로만 자른다.
function readCookie(header: string | undefined): string {
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.setHeader("Allow", "POST, DELETE");
    return res.status(405).json({ error: "POST 또는 DELETE만 받는다" });
  }

  // ⚠️ **feedback.ts와 달리 Origin이 없으면 거절한다.** 거기선 Origin 없는 요청(curl·서버 간)을
  //  통과시켰는데, 여기선 통과시킬 수가 없다 — 팝업 모드의 `redirect_uri`가 「호출한 페이지의
  //  origin」이라 **Origin 헤더가 곧 교환에 쓸 값**이기 때문이다. 모르면 교환을 시작할 수 없다.
  //  ⭐ 덤으로 이게 방어가 된다: 목록에 없는 주소를 redirect_uri로 밀어 넣지 못한다.
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: "허용되지 않은 출처" });
  }

  const dbUrl = process.env.DATABASE_URL;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!dbUrl || !secret) {
    // 설정 실수는 사용자 잘못이 아니다 → 500. 그리고 로그에 남긴다 — 이 한 줄이 없으면
    // "왜 안 되지"를 배포된 곳에서 알아낼 방법이 없다(feedback.ts와 같은 이유).
    console.error("[auth] 환경변수 누락:", !dbUrl && "DATABASE_URL", !secret && "GOOGLE_CLIENT_SECRET");
    return res.status(500).json({ error: "서버 설정 문제" });
  }

  // ── 로그아웃 ──
  // ⭐ 쿠키를 못 읽어도 **성공으로 답한다.** 로그아웃의 목적은 "끝난 상태"이지 "무언가를
  //  지웠음"이 아니다. 이미 없으면 목적은 이미 달성돼 있다 — 여기서 404를 주면 화면이
  //  "로그아웃 실패"를 띄우는데, 사실은 로그아웃돼 있다.
  if (req.method === "DELETE") {
    const raw = readCookie(req.headers.cookie);
    if (raw) {
      try {
        const sql = neon(dbUrl);
        await sql`delete from session where token_hash = ${sha256(raw)}`;
      } catch (e) {
        // ⚠️ 지우기가 실패하면 **쿠키를 만료시키지 않는다.** 브라우저에서만 사라지고 서버엔
        //  살아 있으면 "로그아웃했는데 남의 브라우저에서 되살아나는" 최악이 된다.
        console.error("[auth] 세션 삭제 실패:", e);
        return res.status(500).json({ error: "로그아웃하지 못했어" });
      }
    }
    res.setHeader("Set-Cookie", cookie(origin, "", 0));
    return res.status(204).end();
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
  } catch {
    return res.status(400).json({ error: "JSON이 아니야" });
  }
  const code = typeof payload.code === "string" ? payload.code : "";
  if (!code) return res.status(400).json({ error: "code가 없어" });

  // ── 코드를 토큰으로 ──
  // ⚠️ `redirect_uri`는 **팝업 모드에선 「호출한 페이지의 origin」**이다. `postmessage`가 아니다
  //  (그건 옛 gapi 방식). 틀리면 `redirect_uri_mismatch`가 나는데 그 에러는 원인이 여러 개라
  //  진단이 오래 걸린다 → 2026-08-25에 문서로 확인하고 적어둔다.
  // ⚠️ 이 origin은 Google Cloud Console의 **「승인된 리디렉션 URI」**에도 등록돼 있어야 한다.
  //  「승인된 JavaScript 원본」과 **다른 칸**이다.
  let tok: TokenExchange;
  try {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: secret,
        redirect_uri: origin,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    tok = (await r.json()) as TokenExchange;

    if (!r.ok || tok.error) {
      // ⛔ 사용자에게 구글 원문을 그대로 주지 않는다. 로그로만 — 설정이 새어나간다.
      console.error("[auth] 코드 교환 실패:", r.status, tok.error, tok.error_description);
      return res.status(401).json({ error: "로그인을 완료하지 못했어" });
    }
  } catch (e) {
    console.error("[auth] 코드 교환 중 장애:", e);
    return res.status(500).json({ error: "구글과 통신하지 못했어" });
  }

  // ⭐ **실측 지점** (2026-08-25). 로드맵이 «refresh 토큰이 실제로 오는가»를 여기서 재기로 했다.
  //  GIS 코드 모델에 `access_type`가 없어서 문서만으로는 못 닫혔던 것 → 로그로 한 번 확인한다.
  //  ⛔ 값은 절대 찍지 않는다. **있는지 없는지만**.
  console.log(
    "[auth] 교환 성공 — refresh_token:", tok.refresh_token ? "옴(버린다)" : "안 옴",
    "· id_token:", tok.id_token ? "옴" : "안 옴",
    "· scope:", tok.scope,
  );

  if (!tok.id_token || !tok.access_token) {
    // openid 스코프가 빠지면 id_token이 안 온다 — 그 경우 신원을 알 길이 없다.
    console.error("[auth] 토큰이 모자라다. openid 스코프가 빠졌을 수 있다.");
    return res.status(401).json({ error: "로그인을 완료하지 못했어" });
  }

  let sub: string;
  try {
    sub = readIdToken(tok.id_token);
  } catch (e) {
    console.error("[auth] ID 토큰 검사 실패:", (e as Error).message);
    return res.status(401).json({ error: "로그인을 완료하지 못했어" });
  }
  // 여기서부터 ID 토큰은 쓰지 않는다. 밖으로도 안 나간다 (위 «면제의 조건»).

  // ── 사용자와 세션 ──
  // 쿠키에 담는 값은 여기서만 존재한다. DB에는 sha256만 들어간다 —
  // 세션 값은 그 자체가 신분증이라, 원본을 저장하면 DB 유출이 곧 전원 계정 탈취가 된다.
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);

  try {
    const sql = neon(dbUrl);

    // ⚠️ `do nothing`이 아니라 `do update`인 이유: `do nothing`이면 충돌한 행에 대해
    //  RETURNING이 **아무것도 안 준다**. 이미 있는 사용자의 id를 받아야 하므로 자기 자신으로
    //  덮어쓴다(의미 없는 갱신이지만 이게 표준 관용구다).
    const users = (await sql`
      insert into app_user (google_sub) values (${sub})
      on conflict (google_sub) do update set google_sub = excluded.google_sub
      returning id
    `) as { id: number }[];
    const userId = users[0]?.id;
    if (!userId) throw new Error("app_user id를 못 받았다");

    await sql`
      insert into session (token_hash, user_id, expires_at)
      values (${tokenHash}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))
    `;
  } catch (e) {
    console.error("[auth] 사용자·세션 저장 실패:", e);
    return res.status(500).json({ error: "로그인 상태를 저장하지 못했어" });
  }

  res.setHeader("Set-Cookie", cookie(origin, token, SESSION_DAYS * 24 * 60 * 60));

  // ⭐ 액세스 토큰은 **브라우저에 돌려준다.** 서버가 쥐고 프록시하지 않는다 —
  //  유튜브·드라이브 호출은 지금처럼 브라우저가 직접 하는 게 맞고(30-cors 참고),
  //  그래야 이번 변경이 «인증»에만 머문다. 서버는 경유했을 뿐 **보관하지 않는다.**
  return res.status(200).json({ accessToken: tok.access_token, expiresIn: tok.expires_in ?? 3600 });
}
