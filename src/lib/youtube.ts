// youtube.ts — 구글 로그인(OAuth)으로 내 유튜브 데이터를 직접 읽는다.
//
// 왜 Worker를 안 거치나:
//  Worker를 만든 이유는 ① CORS 우회 ② API 키 숨기기 였는데, OAuth 호출은 **둘 다 해당이 없다.**
//   ① googleapis.com은 CORS를 허용한다 (유튜브 RSS와 달리)
//   ② 토큰은 공용 비밀이 아니라 사용자 본인 것이다 — 오히려 남의 서버로 보내지 않는 편이 안전하다
//  그래서 브라우저가 직접 부른다. worker.ts의 형제이지 대체가 아니다(RSS 경로는 계속 Worker).
//
// ⛔ "나중에 볼"(WL)은 여기서도 못 읽는다. 2016-09-12부터 로그인한 본인에게도 빈 목록이다.
//    (relatedPlaylists.watchLater는 "WL" 문자열만 주고 playlistItems.list는 빈 배열)
//    → watchme 재생목록 우회는 로그인 뒤에도 그대로 유지한다.
//
// 토큰은 1시간짜리이고 refresh token이 없다(정적 사이트의 대가).
//
// ⚠️ **2026-08-15에 뒤집었다.** 원래는 "메모리에만 두고 페이지를 열 때 조용히 재발급받는 편이
//  안전하다"였는데, **그 전제가 틀렸다.** GIS의 `prompt: ""`(silent)는 동의 화면만 건너뛸 뿐
//  **팝업 창은 그대로 연다.** 그래서 새로고침할 때마다 구글 창이 뜨거나 팝업 차단에 막혔다
//  (콘솔에 `Failed to open popup window`가 쌓였다). 조용한 재발급이 공짜가 아니었던 것.
//  → 토큰을 localStorage에 두고 새로고침 너머로 살린다. **열 때 자동 로그인은 하지 않는다.**
//  대가: 토큰이 디스크에 남는다. 1시간 뒤 만료되고, 로그아웃하면 지운다.

// ⚠️ 여기에 Google Cloud Console에서 만든 OAuth 클라이언트 ID를 붙여넣는다.
//  클라이언트 "시크릿"은 쓰지 않는다. 클라이언트 ID는 비밀이 아니라서 공개 저장소에 있어도 된다
//  (승인된 JavaScript 원본으로 도메인이 제한되기 때문).
import type { AppError, Video } from "./types";

// ── 구글 아이덴티티 서비스(GIS)의 모양 ──
// 스크립트를 <script>로 불러오므로 타입이 따로 안 온다. 쓰는 만큼만 여기서 선언한다.
//
// ⭐ **2026-08-25에 토큰 모델 → 코드 모델로 갈아탔다.** 그전엔 `initTokenClient`로 액세스
//  토큰을 브라우저가 직접 받았는데, 그 응답에는 **`id_token`이 없다**(인가만 하고 신원은
//  안 준다). 서버가 "이 요청이 누구인지"를 알아야 해서 코드 모델로 옮겼다.
//  → 이제 브라우저는 **인가 코드만** 받고, 토큰으로 바꾸는 일은 `/api/auth`가 한다.
//    근거는 ROADMAP.md «🔐 인증 설계 확정».
type CodeResponse = { code?: string; scope?: string; error?: string; error_description?: string };
type CodeClient = { requestCode: () => void };

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initCodeClient: (cfg: {
            client_id: string;
            scope: string;
            ux_mode: "popup" | "redirect";
            callback: (resp: CodeResponse) => void;
            error_callback?: (err: { type?: string }) => void;
          }) => CodeClient;
          revoke: (token: string, done: () => void) => void;
        };
      };
    };
  }
}

// ⚠️ `CLIENT_ID`는 이제 여기 없다 — **서버(`api/auth.ts`)도 같은 값이 필요해져서** 공유
//  모듈로 옮겼다. 두 곳에 적어두면 어긋날 수 있고, 어긋나면 증상이 «aud 불일치»라
//  진단이 엉뚱한 데로 간다.
export { CLIENT_ID } from "./oauth-config";
import { CLIENT_ID } from "./oauth-config";

// 스코프 셋. **한 번의 로그인으로 전부 받는다** — 사용자에겐 여전히 버튼 하나다.
//  ① openid           … **신원**. 이게 있어야 서버가 ID 토큰을 받고 `sub`를 꺼낸다 (2026-08-25 추가)
//  ② youtube.readonly … 읽기 전용 하나로 구독·재생목록·영상 조회가 전부 커버된다
//  ③ drive.appdata    … **앱 전용 숨은 폴더에만** 접근한다(2026-08-04, 기기 동기화).
//     사용자의 다른 드라이브 파일은 보이지도 않는다 — 드라이브 권한 중 가장 좁은 것.
// ⛔ `email`·`profile`은 **일부러 안 받는다.** 필요한 건 `sub` 하나뿐이고,
//    안 받으면 실수로 저장할 일도 없다(`api/auth.ts`가 다른 클레임을 안 읽는 것과 같은 이유).
// ⚠️ 스코프를 늘리면 **동의 화면을 다시 받아야 한다.** ①을 더한 2026-08-25부터 기존
//    사용자(테스터 4명 포함)도 한 번은 로그인 버튼을 눌러야 한다.
const SCOPE = [
  "openid",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/drive.appdata",
].join(" ");
const API = "https://www.googleapis.com/youtube/v3";
const MAX_PAGES = 20; // 50개 × 20 = 최대 1000개 (Worker의 한도와 같게 맞춘다)

let token: string | null = null;
let expiresAt = 0;


export const isSignedIn = () => !!token && Date.now() < expiresAt;

// ── 토큰 보관 (localStorage) ──
// ⚠️ 이 키만 storage.js 밖에 있다. 토큰은 **앱 데이터가 아니라 세션**이고,
//    무엇보다 `exportAll`에 절대 실리면 안 되기 때문이다(드라이브에 남의 손이 닿는 곳으로 간다).
//    storage.ts의 KEYS 주석에도 이 예외를 적어뒀다.
const TOKEN_KEY = "authToken";

// localStorage는 사용자가 손댈 수 있는 곳이라, 깨진 값이 있어도 앱이 죽지 않게 감싼다.
function saveToken() {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  } catch {}
}

function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// 모듈이 로드될 때 한 번. 아직 살아 있는 토큰만 되살리고, 만료된 것은 지운다.
// (여기서 notify는 안 한다 — 아직 아무도 안 듣고 있고, 화면이 isSignedIn()으로 첫 상태를 읽는다)
(function restoreToken() {
  try {
    const v = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (v && typeof v.token === "string" && Date.now() < v.expiresAt) {
      token = v.token;
      expiresAt = v.expiresAt;
    } else if (v) {
      clearToken();
    }
  } catch {
    clearToken();
  }
})();

// 로그인 상태가 바뀌면 화면이 알아야 한다 (버튼 문구·구독 버튼 노출)
const listeners = new Set<(on: boolean) => void>();
export const onAuthChange = (fn: (on: boolean) => void) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn(isSignedIn()));

// ⭐ **실패를 종류로 가른다.** 「취소했다」와 「서버가 거절했다」는 사람이 할 일이 다르다 —
//  앞은 다시 누르면 되고, 뒤는 설정을 봐야 한다. 07-31에 세운 «무엇이 실패했나보다
//  어디까지 갔나» 규칙을 로그인에도 그대로 적용한다(90-gotchas 15).
export type AuthResult = { ok: true } | { ok: false; reason: "cancelled" | "server" | "script"; message: string };

// GIS(구글 아이덴티티 서비스) 스크립트는 index.html에서 비동기로 불러온다.
// 버튼을 누른 시점에 아직 안 왔을 수 있어 잠깐 기다린다.
async function ensureGis() {
  for (let i = 0; i < 40 && !window.google?.accounts?.oauth2; i++) {
    await new Promise((r) => setTimeout(r, 50)); // 최대 2초
  }
  const gis = window.google?.accounts?.oauth2;
  if (!gis) throw new Error("구글 로그인 스크립트를 못 불러왔어");
  return gis;
}

// ⚠️ **`silent` 옵션이 사라졌다.** 코드 모델(`initCodeClient`)에는 `prompt` 파라미터가
//  아예 없어서 「동의 창 없이 조용히」를 지시할 방법이 없다. 어차피 2026-08-15에 자동
//  재발급을 걷어냈고(90-gotchas 21 — silent가 팝업을 열어 차단당했다) 부르는 곳도 없었다.
//
// ⭐ 클라이언트를 **매번 새로 만든다.** 예전엔 하나를 만들어두고 `callback`을 갈아끼웠는데,
//  코드 모델은 그 필드를 갈아끼워도 되는지 문서가 보장하지 않는다. 만드는 데 네트워크가
//  들지 않으므로 **보장되지 않는 것에 기대는 대신 매번 만든다.**
export async function signIn(): Promise<AuthResult> {
  let gis: NonNullable<NonNullable<NonNullable<Window["google"]>["accounts"]>["oauth2"]>;
  try {
    gis = await ensureGis();
  } catch (e) {
    return { ok: false, reason: "script", message: (e as Error).message };
  }

  // 1단계: 팝업에서 **인가 코드만** 받는다. 토큰은 여기서 안 나온다.
  const resp = await new Promise<CodeResponse | null>((resolve) => {
    const client = gis.initCodeClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      ux_mode: "popup", // ⛔ redirect로 바꾸면 페이지가 통째로 튕겨나가 화면 상태가 날아간다
      callback: resolve,
      // 팝업을 닫거나 브라우저가 막았을 때. 이게 없으면 promise가 영영 안 풀린다.
      error_callback: () => resolve(null),
    });
    client.requestCode();
  });

  if (!resp || resp.error || !resp.code) {
    if (resp?.error) console.warn("[auth] 코드 요청 실패:", resp.error, resp.error_description);
    return { ok: false, reason: "cancelled", message: "로그인이 취소됐어." };
  }

  // 2단계: 코드를 내 서버로. **여기서 세션 쿠키가 심어진다**(HttpOnly라 JS는 못 읽는다).
  // 같은 origin이라 쿠키는 알아서 오간다 — `credentials` 기본값이 same-origin이다.
  let data: { accessToken?: string; expiresIn?: number; error?: string } = {};
  try {
    const r = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: resp.code }),
    });
    data = await r.json().catch(() => ({}));
    if (!r.ok || !data.accessToken) {
      console.warn("[auth] 서버가 코드를 거절했다:", r.status, data.error);
      return { ok: false, reason: "server", message: data.error || "로그인을 완료하지 못했어." };
    }
  } catch (e) {
    console.warn("[auth] 서버에 못 닿았다:", e);
    return { ok: false, reason: "server", message: "서버에 연결하지 못했어." };
  }

  token = data.accessToken;
  // 만료 1분 전에 만료된 것으로 친다 (호출 중간에 끊기지 않게)
  expiresAt = Date.now() + (data.expiresIn || 3600) * 1000 - 60_000;
  saveToken();
  notify();
  return { ok: true };
}

// ⭐ **로그아웃은 이제 두 곳을 끈다** (2026-08-25): 브라우저의 토큰과 **서버의 세션**.
//  로컬만 지우면 화면은 로그아웃으로 보이는데 서버는 여전히 나로 알고 있다 —
//  같은 브라우저를 쓰는 다음 사람이 내 데이터에 접근한다.
//
// ⚠️ 순서를 이렇게 잡은 이유: **로컬을 먼저 지운다.** 서버가 안 되는데 로그아웃 자체를
//  막으면, 공용 컴퓨터에서 지금 당장 나가야 하는 사람이 못 나간다. 대신 서버 쪽이
//  실패하면 **조용히 넘기지 않고 말해준다** — 그래야 사람이 다른 수를 쓴다.
export async function signOut(): Promise<AuthResult> {
  const revoked = token;
  token = null;
  expiresAt = 0;
  clearToken();
  notify();

  let result: AuthResult = { ok: true };
  try {
    const r = await fetch("/api/auth", { method: "DELETE" });
    if (!r.ok) result = { ok: false, reason: "server", message: "서버 세션을 못 끊었어." };
  } catch {
    result = { ok: false, reason: "server", message: "서버 세션을 못 끊었어 (연결 실패)." };
  }

  // ⚠️ 구글 쪽 동의까지 취소한다 → **다음 로그인 때 동의 화면이 다시 뜬다.** 원래 동작이고,
  //  "로그아웃했는데 권한은 남아 있는" 상태를 안 만드는 쪽이 맞다고 본 것이다.
  if (revoked) window.google?.accounts?.oauth2?.revoke(revoked, () => {});
  return result;
}

// ────────────────────────── 호출 ──────────────────────────

// 토큰을 쥐고 있는 곳은 이 파일 하나여야 한다. 그래서 **토큰을 넘겨주는 대신 창구를 빌려준다.**
// drive.ts가 이걸 쓴다 — 호스트가 달라(googleapis.com/drive) URL을 통째로 받는다.
//  · 응답 해석은 하지 않는다: 유튜브는 늘 JSON이지만 Drive는 **파일 본문**도 돌려주기 때문.
//  · 401(토큰 만료)만 여기서 처리한다. 모든 호출자가 똑같이 해야 하는 일이라서.
export async function authedFetch(url: string, init: RequestInit = {}) {
  if (!isSignedIn()) {
    const err: AppError = new Error("로그인이 필요해");
    err.needsAuth = true;
    throw err;
  }
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (res.status === 401) {
    // 토큰이 죽었다 → 다음 호출 전에 다시 받도록 비운다. 저장된 것도 같이 지운다
    // (안 지우면 새로고침할 때 죽은 토큰이 되살아나 "로그인됨"으로 보인다)
    token = null;
    expiresAt = 0;
    clearToken();
    notify();
    const err: AppError = new Error("로그인이 만료됐어. 다시 로그인해줘");
    err.needsAuth = true;
    throw err;
  }
  return res;
}

// 에러 모양은 worker.ts와 맞춘다(err.notFound). 그래야 화면의 안내 코드가 그대로 쓰인다.
type ApiPage = {
  items?: Record<string, any>[];
  nextPageToken?: string;
  pageInfo?: { totalResults?: number };
  error?: { message?: string; errors?: { reason?: string }[] };
};

async function get(path: string, params: Record<string, string>): Promise<ApiPage> {
  const res = await authedFetch(`${API}${path}?` + new URLSearchParams(params));
  const data = (await res.json().catch(() => ({}))) as ApiPage;
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || "";
    const err: AppError = new Error(data?.error?.message || "HTTP " + res.status);
    err.notFound = reason === "playlistNotFound" || res.status === 404;
    throw err;
  }
  return data;
}

// 페이지를 끝까지 넘기며 모으는 공통 루프 (구독·재생목록이 같은 모양이라 하나로)
async function pages<T>(
  path: string,
  params: Record<string, string>,
  take: (items: Record<string, any>[], out: T[]) => void,
  onProgress?: (got: number, total: number) => void
): Promise<T[]> {
  const out: T[] = [];
  let pageToken = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const data = await get(path, pageToken ? { ...params, pageToken } : params);
    take(data.items || [], out);
    onProgress?.(out.length, data.pageInfo?.totalResults ?? 0);
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return out;
}

// ── 구독 목록 → 내 채널 목록에 넣을 모양 ──
// → [{ channelId, name }]
export type Subscription = { channelId: string; name: string };

export function fetchSubscriptions(onProgress?: (got: number, total: number) => void) {
  return pages<Subscription>(
    "/subscriptions",
    { part: "snippet", mine: "true", maxResults: "50", order: "alphabetical" },
    (items, out) => {
      for (const it of items) {
        const channelId = it.snippet?.resourceId?.channelId;
        if (channelId) out.push({ channelId, name: it.snippet?.title || channelId });
      }
    },
    onProgress
  );
}

// ── 재생목록 → worker.ts의 /playlist와 **같은 모양** ──
// 그래서 화면 코드는 어느 쪽에서 받았는지 몰라도 된다.
export async function fetchPlaylist(id: string) {
  let skipped = 0;
  const videos = await pages<Video>(
    "/playlistItems",
    { part: "snippet,contentDetails", playlistId: id, maxResults: "50" },
    (items, out) => {
      for (const it of items) {
        const vid = it.contentDetails?.videoId;
        const published = it.contentDetails?.videoPublishedAt;
        // 비공개·삭제된 영상은 볼 수 없으니 후보에서 뺀다 (videoPublishedAt이 없다)
        if (!vid || !published) {
          skipped++;
          continue;
        }
        out.push({
          id: vid,
          title: it.snippet?.title || "(제목 없음)",
          link: `https://www.youtube.com/watch?v=${vid}`,
          date: published.slice(0, 10),
          published,
          channel: it.snippet?.videoOwnerChannelTitle || "",
        });
      }
    }
  );
  return { playlistId: id, count: videos.length, skipped, videos };
}

// videos.list(ID 묶음 → 영상 상세)를 부르던 fetchVideos/fetchVideosChunked는
// "나중에 볼에서 뽑은 ID 가져오기"만 쓰던 것이라 2026-08-07에 그 기능과 함께 지웠다.
// 풀은 이제 재생목록 동기화(fetchPlaylist)로만 채운다. 되살릴 일이 생기면 git 이력에서 꺼낸다.
