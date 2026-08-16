// rss-proxy.js — youtube-feed 전용 RSS 릴레이 (Cloudflare Workers)
//
// 왜 만들었나:
//  브라우저가 유튜브 RSS를 직접 fetch하면 CORS에 막힌다.
//  그래서 남의 공개 프록시를 빌려 썼는데, 무료 공용이라 레이트 리밋·과부하로 자주 실패했다.
//  → "내가 통제하는 릴레이"를 하나 둔다. (아키텍처 유형 L3 = 요청시 동적·무상태)
//
// 계약(interface) — 지금은 이 하나뿐이다:
//  GET /rss?ch=<채널ID | @핸들 | 채널URL>&limit=3
//  →  { "channelId": "UC...", "name": "채널명",
//       "videos": [ { "id": "...", "title": "...", "link": "...",
//                     "date": "YYYY-MM-DD", "published": "ISO8601" } ] }
//
// 2026-08-16: **실패의 종류를 갈랐다.** 그전엔 전부 502였다.
//  200 { channelId, name,       videos: [...] }                 정상 — 모양이 안 바뀐다
//  200 { channelId, name,       videos: [], state: "empty" }    살아있는데 공개 영상 0개
//  200 { channelId, name: null, videos: [], state: "gone"  }    채널 404 — 삭제·정지됨
//  404 { error }   입력을 채널로 해석 못 함 (@핸들 오타 등)
//  502 { error }   진짜 장애 — 유튜브 5xx·네트워크. **재시도가 의미 있는 경우만**
//  400 { error }   ch 파라미터 없음
//
//  ⭐ 왜 "죽었다"가 200인가: 채널이 삭제됐다는 것은 **릴레이가 성공적으로 알아낸 사실**이지
//   릴레이의 고장이 아니다. 5xx로 주면 "서버가 아픈가?"를 다시 의심하게 된다 — 2026-08-05에
//   실제로 그 오진에 시간을 썼다(모든 예외를 502로 뭉갠 게 원인이었다). 5xx는 이제
//   **"답을 모르겠다"일 때만** 쓴다. 그래야 상태코드가 곧 "재시도해도 되나"의 답이 된다.
//
//  ⭐ 정상 응답은 **한 글자도 안 바뀐다**(state 없음 = 정상). 저장된 채널의 `active`,
//   백업 payload와 같은 규약 — 기존 필드는 그대로 두고 **추가만** 한다.
//   그래서 이 Worker를 먼저 배포해도 옛 화면이 안 깨진다. Worker는 대시보드에 손으로
//   붙여넣는 것이라 화면과 배포가 따로 노는데, 그 순서를 신경 안 써도 된다는 뜻이다.
//
// 2026-07-31: /playlist·/videos(YouTube Data API)를 걷어냈다.
//  구글 로그인이 붙으면서 그쪽은 **브라우저가 유튜브를 직접** 부른다(src/youtube.js).
//  릴레이의 존재 이유였던 ①CORS ②키 숨기기가 OAuth 호출엔 둘 다 해당이 없기 때문.
//  → 이제 이 Worker는 **API 키를 쓰지 않는다.** Cloudflare의 YT_API_KEY 시크릿도 지웠다.
//  되살릴 일이 생기면 git 이력에서: git log --oneline -- worker/rss-proxy.js
//
// 상태(state) 없음: DB도 로그인도 없다. 받아서 가공해 돌려줄 뿐.

// 내 사이트에서만 쓰도록 제한 (아무나 내 Worker를 무료 프록시로 쓰지 못하게)
const ALLOWED_ORIGINS = [
  "https://emithen.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
];

// 유튜브가 브라우저인 척 해야 잘 열림
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    // 브라우저가 본 요청 전에 보내는 사전 확인(preflight)
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // 살아있는지 확인용
    if (url.pathname === "/") {
      return json({ ok: true, usage: ["/rss?ch=@handle 또는 UC..."] }, 200, cors);
    }

    try {
      if (url.pathname === "/rss") {
        const ch = (url.searchParams.get("ch") || "").trim();
        if (!ch) return json({ error: "ch 파라미터가 필요해" }, 400, cors);
        const limit = Math.min(Number(url.searchParams.get("limit")) || 3, 15);
        const channelId = await resolveChannelId(ch);
        const feed = await fetchFeed(channelId, limit);
        return json({ channelId, ...feed }, 200, cors);
      }

      return json({ error: "없는 경로" }, 404, cors);
    } catch (e) {
      // 여기까지 내려오는 것은 **답을 못 낸 경우뿐이다.**
      // "채널이 죽었다"·"영상이 없다"는 위에서 200으로 답하고 이리로 오지 않는다.
      const status = e instanceof NotFound ? 404 : 502;
      // 실패는 캐시하지 않는다. 일시적 장애가 10분간 굳어버리면 안 되니까.
      // 404(오타)도 캐시하지 않는다 — 방금 만든 채널이 10분간 "없는 채널"로 굳으면 곤란하다.
      return json({ error: String(e.message || e) }, status, corsHeaders(origin, "no-store"));
    }
  },
};

// 입력을 채널로 해석하지 못했다. 릴레이는 멀쩡하고 **요청이 틀린 것**이라 404로 답한다.
// (채널이 삭제된 것과는 다르다 — 그건 해석은 됐고 실제로 사라진 경우라 200 + state:"gone".)
class NotFound extends Error {}

// ────────────────────────── CORS ──────────────────────────
function corsHeaders(origin, cache = "public, max-age=600") {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    // ⚠️ 필수: 응답의 CORS 헤더가 Origin마다 다르므로 캐시도 Origin별로 나눠 저장해야 한다.
    //  없으면 localhost에서 만든 응답이 github.io 요청에 재사용돼 CORS 불일치로 죽는다(실제로 겪음).
    "Vary": "Origin",
    // 같은 채널을 자주 부르면 캐시가 대신 답한다 (유튜브 부담·속도 개선)
    "Cache-Control": cache,
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

// ────────────────────────── 입력 → channel_id ──────────────────────────
async function resolveChannelId(input) {
  // 1) 이미 channel_id
  if (/^UC[\w-]{20,}$/.test(input)) return input;
  // 2) URL 안에 /channel/UC...
  const inUrl = input.match(/channel\/(UC[\w-]{20,})/);
  if (inUrl) return inUrl[1];
  // 3) @핸들·커스텀 URL → 채널 페이지에서 찾아낸다 (서버에서 하니 브라우저보다 훨씬 빠름)
  let pageUrl = input;
  if (input.startsWith("@")) pageUrl = "https://www.youtube.com/" + input;
  else if (!/^https?:\/\//.test(input)) pageUrl = "https://www.youtube.com/@" + input;

  let html;
  try {
    html = await getText(pageUrl, 3600); // 핸들→ID는 안 바뀌니 1시간 캐시
  } catch (e) {
    // 채널 페이지가 404 = 그런 핸들이 애초에 없다. 장애가 아니라 오타다.
    if (e.upstream === 404) throw new NotFound("그런 채널이 없어 (핸들·링크를 확인해줘)");
    throw e;
  }

  // ⚠️ 채널 페이지는 2.4MB나 되고, 그 안엔 "추천 채널"의 ID도 잔뜩 들어있다.
  //  - 정규식으로 전체를 훑으면 Worker CPU 한도(10ms)를 넘겨 죽는다 → indexOf로 위치만 찾는다.
  //  - 먼저 나오는 "channelId"를 집으면 엉뚱한 추천 채널이 잡힌다(@mkbhd→The Studio 사고).
  //    canonical 링크가 "이 페이지의 진짜 주인"이므로 그것부터 본다.
  const id =
    findAfter(html, 'rel="canonical" href="https://www.youtube.com/channel/') ||
    findAfter(html, '"externalId":"') ||
    findAfter(html, '"channelId":"'); // 최후 수단
  if (!id) throw new NotFound("채널 ID를 못 찾았어 (링크를 확인해줘)");
  return id;
}

// marker 바로 뒤에서 채널 ID를 꺼낸다. indexOf(네이티브 검색)라 큰 문서에서도 싸다.
function findAfter(html, marker) {
  const i = html.indexOf(marker);
  if (i === -1) return null;
  const start = i + marker.length;
  const m = html.slice(start, start + 40).match(/^(UC[\w-]{20,})/);
  return m ? m[1] : null;
}

// ────────────────────────── channel_id → 채널명 + 영상들 ──────────────────────────
async function fetchFeed(channelId, limit) {
  let xml;
  try {
    xml = await getText(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      600 // 영상 목록은 10분 캐시
    );
  } catch (e) {
    // 피드 자체가 404 = 채널이 삭제·정지됐다. **이건 답이지 고장이 아니다.**
    // 이름은 줄 수 없다 — 응답이 아예 없어서 읽을 곳이 없다.
    if (e.upstream === 404) return { name: null, videos: [], state: "gone" };
    throw e; // 5xx·네트워크는 진짜 장애 → 502
  }

  // 채널명: 첫 <entry> 앞쪽의 <title>
  const head = xml.split("<entry>")[0];
  const name = decode((head.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || channelId);

  const videos = xml
    .split("<entry>")
    .slice(1, limit + 1)
    .map((chunk) => {
      // published는 "2026-07-22T03:04:59+00:00" 같은 전체 시각.
      //  date(날짜만)는 화면 표시용, published(시각까지)는 "24시간 이내" 계산용으로 둘 다 준다.
      const published = (chunk.match(/<published>([^<]+)<\/published>/) || [])[1] || "";
      return {
        // id는 RSS의 <yt:videoId>. 영상을 식별하는 열쇠(예: "본 영상" 기록에 씀).
        id: (chunk.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1] || "",
        title: decode((chunk.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "(제목 없음)"),
        link: (chunk.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || "#",
        date: published.slice(0, 10),
        published,
      };
    });

  // 영상 0개는 **정상 상황**이다 — 채널은 살아 있고(피드가 200이었다) 공개 영상만 없다.
  // 예전엔 여기서 throw해서 502가 됐다. 2026-08-05에 원인을 규명하고도 남겨둔 자리다.
  // 이름은 <entry> 앞쪽에서 읽으므로 영상이 없어도 멀쩡히 나온다 → 화면에 채널명을 띄울 수 있다.
  if (videos.length === 0) return { name, videos: [], state: "empty" };

  return { name, videos };
}

// ────────────────────────── 공통: 텍스트 가져오기 (엣지 캐시 사용) ──────────────────────────
async function getText(target, cacheTtl) {
  const res = await fetch(target, {
    headers: { "User-Agent": UA, "Accept-Language": "ko,en;q=0.8" },
    cf: { cacheTtl, cacheEverything: true }, // Cloudflare가 알아서 캐시해줌
  });
  if (!res.ok) {
    const e = new Error("유튜브 응답 " + res.status);
    // 부르는 쪽이 404(없는 채널 = 답)와 5xx(일시 장애 = 고장)를 갈라야 한다.
    // 메시지 문자열을 파싱해서 판정하지 않는다 — 그 방식이 지금까지 조용히 틀려 있었다.
    e.upstream = res.status;
    throw e;
  }
  return res.text();
}

// XML 엔티티 되돌리기 (&amp; → & 등)
function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
