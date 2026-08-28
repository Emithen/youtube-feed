// rss-proxy.js — youtube-feed 전용 RSS 릴레이 (Cloudflare Workers)
//
// 브라우저는 유튜브 RSS를 직접 못 읽는다(CORS). 이 릴레이가 대신 읽어 JSON으로 준다.
// 무상태 — DB도 로그인도 API 키도 없다. 받아서 가공해 돌려줄 뿐이다.
//
// ── 계약 ──
//  GET /rss?ch=<채널ID | @핸들 | 채널URL>&limit=3      (limit 최대 15)
//   200 { channelId, name, videos: [{ id, title, link, date, published, short? }] }
//   200 { channelId, name, videos: [], state: "empty" }                      살아있고 공개 영상 0개
//   200 { channelId, name: null, videos: [], state: "gone", verified: true } 삭제·정지 확인됨
//   404 { error }   입력을 채널로 해석 못 함 (@핸들 오타 등)
//   502 { error }   장애 — **재시도가 의미 있을 때만**
//   400 { error }   ch 없음
//  GET /  → { ok, usage }  헬스체크
//
// 계약을 읽는 규칙 셋:
//  ⭐ **상태코드가 곧 "재시도해도 되나"의 답이다.** 알아낸 사실(gone·empty)은 릴레이의
//   고장이 아니므로 200으로 주고, 5xx는 **답을 모를 때만** 쓴다.
//  ⭐ **필드는 추가만 한다.** 이 Worker는 대시보드에 손으로 붙여넣어서 화면과 배포 시점이
//   어긋난다 — 어느 쪽을 먼저 올려도 안 깨져야 한다.
//  ⭐ optional 필드(`verified`·`short`)의 **없음은 «아니오»가 아니라 «모른다»**다.
//
// 왜 이렇게 됐는지(사고 기록·실측 수치)는 _life의 docs/core/youtube-feed/에 있다.

// 내 사이트에서만 쓰도록 제한 (아무나 내 Worker를 무료 프록시로 쓰지 못하게).
//
// ⚠️ **여기 없는 origin은 CORS에 막혀 채널이 하나도 안 뜬다.** 배포 주소를 옮길 땐
//  새 주소를 먼저 넣어 배포하고 옛 주소를 지운다 — 둘 다 살아 있는 기간이 필요하다.
// ⚠️ Vercel 프리뷰 주소는 배포마다 바뀌어 등록할 수 없다 → 프리뷰에서 채널이 안 뜨는 건 정상.
const ALLOWED_ORIGINS = [
  "https://youtube-feed-mu.vercel.app",
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
      return json({ error: String(e.message || e) }, status, cors);
    }
  },
};

// 입력을 채널로 해석하지 못했다. 릴레이는 멀쩡하고 **요청이 틀린 것**이라 404로 답한다.
// (채널이 삭제된 것과는 다르다 — 그건 해석은 됐고 실제로 사라진 경우라 200 + state:"gone".)
class NotFound extends Error {}

// ────────────────────────── CORS ──────────────────────────
// ⭐ **캐시 지시는 하나뿐이다: 저장하지 마라.** 판정마다 TTL을 달리 매기는 건 틀린 답을
//  싸게 만들 뿐 답을 맞히지 못한다 — 맞히는 일은 confirmGone이 한다. 게다가 이 층이
//  없어도 손해가 없다: 유튜브 부담은 getText의 엣지 캐시가, 체감 속도는 화면의
//  localStorage 캐시가 이미 맡는다. 남는 순효과는 **다시 물어보지 못하게 막는 것**뿐이다.
function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    // ⚠️ 응답의 CORS 헤더가 Origin마다 다르다 → 저장된다면 Origin별로 나뉘어야 한다.
    //  지금은 no-store라 저장될 일이 없지만, 캐시를 되살리는 순간 다시 필수가 된다.
    "Vary": "Origin",
    "Cache-Control": "no-store",
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
  //  · 정규식으로 전체를 훑으면 Worker CPU 한도(10ms)를 넘겨 죽는다 → indexOf로 위치만 찾는다.
  //  · 먼저 나오는 "channelId"를 집으면 엉뚱한 추천 채널이 잡힌다 →
  //    "이 페이지의 진짜 주인"인 canonical부터 본다.
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
    // ⚠️ **RSS의 404는 증거이지 증명이 아니다.** 유튜브는 일시 과부하·스로틀링에도 404를
    //  주고, 진짜 없는 채널의 404와 응답만으로는 가릴 수 없다 → 확정은 confirmGone이 받아온다.
    if (e.upstream === 404) return confirmGone(channelId);
    throw e; // 5xx·네트워크는 진짜 장애 → 502
  }

  // 채널명: 첫 <entry> 앞쪽의 <title>
  const head = xml.split("<entry>")[0];
  const name = decode((head.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || channelId);

  const videos = xml
    .split("<entry>")
    .slice(1, limit + 1)
    .map((chunk) => {
      // date(날짜만)는 화면 표시용, published(시각까지)는 "24시간 이내" 계산용. 둘 다 준다.
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

  await markShorts(videos);

  // 영상 0개는 **정상 상황**이다 — 채널은 살아 있고(피드가 200이었다) 공개 영상만 없다.
  // 이름은 <entry> 앞쪽에서 읽으므로 영상이 없어도 나온다 → 화면에 채널명을 띄울 수 있다.
  if (videos.length === 0) return { name, videos: [], state: "empty" };

  return { name, videos };
}

// ────────────────────────── RSS 404의 진위 확인 ──────────────────────────
// RSS가 404를 줬을 때 **다른 문으로 같은 질문을 한 번 더 한다.**
//
// ⭐ 재시도가 아니라 **다른 엔드포인트에 묻는 것**이 핵심이다. 같은 문을 또 두드리면 같은
//  확률로 또 틀린다 — 확률은 확정이 되지 않는다. 채널 페이지는 RSS와 별개로 서비스된다.
//
// ⚠️ 채널 페이지는 **없는 채널에도 200을 준다**(소프트 404) → 상태코드가 아니라 본문의 표지를 본다.
// ⛔ 그 표지로 `"channelId":"`를 쓰면 안 된다. 죽은 페이지에도 그게 하나 있는데
//  **우리가 URL로 보낸 ID가 그대로 되울려 나온 것**이다(에코).
//  → **살아있는 페이지에만 있는 표지**(canonical·externalId)만 본다.
async function confirmGone(channelId) {
  let html;
  try {
    // 살아있음은 바뀔 수 있다(채널은 언제든 삭제된다) → 핸들→ID의 1시간보다 짧게 잡는다.
    html = await getText(`https://www.youtube.com/channel/${channelId}`, 300);
  } catch (e) {
    // 채널 페이지까지 404 = **서로 다른 두 문이 같은 답을 했다.** 이제야 확정이다.
    if (e.upstream === 404) return { name: null, videos: [], state: "gone", verified: true };
    // 확인 자체를 못 했다 → **모른다.** 모르는 것을 사실로 단정하지 않는다 → 502.
    throw e;
  }

  const alive =
    html.includes('rel="canonical" href="https://www.youtube.com/channel/') ||
    html.includes('"externalId":"');

  if (alive) {
    // 채널은 살아있는데 RSS만 404다 = 유튜브 쪽 일시 장애. **재시도가 의미 있다** → 502.
    const e = new Error("유튜브 RSS가 일시적으로 404를 주고 있어 (채널은 살아있음)");
    e.upstream = 503; // NotFound가 아니므로 바깥 catch에서 502가 된다
    throw e;
  }

  // 200을 받았는데 살아있다는 표지가 없다 = 소프트 404. 확정된 삭제다.
  return { name: null, videos: [], state: "gone", verified: true };
}

// ────────────────────────── 쇼츠인가 롱폼인가 ──────────────────────────
// ⚠️ **RSS에는 이 정보가 없다** — 길이도 쇼츠 표시도 없고, 쇼츠도 링크가 `/watch?v=`로 온다.
//  → confirmGone과 같은 수법으로 **다른 문에 묻는다.**
//
// ⭐ 판별: `youtube.com/shorts/<id>`를 **따라가지 않고** 열어본다. **200 = 쇼츠, 303 = 롱폼**
//  (롱폼이면 `/watch?v=…`로 되돌려 보낸다).
//  ⛔ **길이로 짐작하지 않는다.** 쇼츠 상한이 3분이라 81초·107초짜리 쇼츠가 실제로 있다 —
//   길이는 우리가 만든 짐작이고 이 리다이렉트는 **유튜브 자신의 판정**이다.
//   (길이는 Data API로 받을 수 있지만 로그인이 필요하다. 피드는 로그인 없이 보는 화면이다.)
// ⚠️ **HEAD로 부른다.** GET이면 쇼츠일 때 1MB대 본문이 통째로 딸려온다.
// ⭐ **모르면 필드를 안 붙인다.** 화면은 필드가 없으면 아무 배지도 안 그린다.
// ⬜ 캐시 없음: 쇼츠 여부는 안 바뀌는 사실이라 캐시해도 되지만 **workers.dev 주소에서는
//  Cache API가 동작하지 않고** `cf.cacheTtl`은 GET에만 걸린다.
//  🚦 피드가 눈에 띄게 느려지거나 유튜브가 스로틀링하면 → 커스텀 도메인 + Cache API.
async function markShorts(videos) {
  // 채널 하나당 최대 limit개(기본 6). 순차로 하면 그만큼 왕복이 쌓이므로 한꺼번에 던진다.
  await Promise.all(
    videos.map(async (v) => {
      if (!v.id) return; // id를 못 읽은 영상은 물어볼 주소가 없다
      try {
        const res = await fetch(`https://www.youtube.com/shorts/${v.id}`, {
          method: "HEAD",
          redirect: "manual", // ⛔ 따라가면 전부 200으로 보여서 죄다 쇼츠가 된다
          headers: { "User-Agent": UA },
          // ⚠️ 타임아웃이 없으면 **배지 하나가 채널 전체 응답을 붙잡는다.** 곁가지 판정이므로
          //  오래 걸리면 그냥 모르는 채로 둔다.
          signal: AbortSignal.timeout(3000),
        });
        if (res.status === 200) v.short = true;
        else if (res.status === 303) v.short = false;
        // 그 밖은 모른다 → 아무것도 안 적는다
      } catch {
        // 네트워크 실패도 «모른다». 판정 하나 때문에 채널 전체를 실패시키지 않는다.
      }
    })
  );
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
    // ⛔ 메시지 문자열을 파싱해서 판정하지 않는다 — 그 방식은 조용히 틀려도 아무도 모른다.
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
