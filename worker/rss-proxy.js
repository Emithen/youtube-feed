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
//  200 { channelId, name: null, videos: [], state: "gone", verified: true }  삭제·정지 **확인됨**
//  404 { error }   입력을 채널로 해석 못 함 (@핸들 오타 등)
//  502 { error }   진짜 장애 — 유튜브 5xx·네트워크. **재시도가 의미 있는 경우만**
//  400 { error }   ch 파라미터 없음
//
// 2026-08-21: **판정에 "모른다"를 만들었다.** 그전엔 알아냈다/못 알아냈다 둘뿐이었다.
//  RSS의 404를 그대로 "삭제됨"으로 믿었는데 유튜브가 일시 장애에도 404를 주는 걸 확인했다
//  (그날 살아있는 채널 40개가 전부 "없어졌어"로 떴다). → 404는 **증거이지 증명이 아니다.**
//   RSS 404 → 채널 페이지에 확인 → 살아있음   : 502 (RSS만 아픔, 재시도하라)
//                                → 없음       : 200 state:"gone", verified:true
//                                → 확인 실패   : 502 (**모른다**. 단정하지 않는다)
//  ⭐ `verified`를 붙인 이유: Worker는 대시보드에 손으로 붙여넣는 것이라 화면과 배포가
//   따로 논다. 옛 Worker는 이 필드 없이 `gone`만 보내는데, 화면이 그걸 "미확인 판정"으로
//   읽고 캐시된 영상을 지우지 않게 하려는 것이다. 기존 필드는 그대로 두고 **추가만** 한다.
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
//
// ⚠️ **여기에 없는 origin은 CORS에 막혀 채널이 하나도 안 뜬다.** 배포 주소를 옮길 땐
//  옛 주소를 지우기 전에 새 주소를 먼저 넣고 배포한다(둘 다 살아 있는 기간이 필요하다).
//  2026-08-16: GitHub Pages → Vercel 이사. **옛 주소를 남겨둔 이유**는 사용자의
//  localStorage가 origin별로 격리돼 있어서다 — 옛 주소에서 `☁️ 올리기`로 드라이브에
//  올려야 새 주소에서 `내려받기`로 데이터를 옮길 수 있다. 이사가 끝나면 지운다.
//
// ⚠️ Vercel **프리뷰 배포 주소는 배포마다 바뀐다**(youtube-feed-git-xxxx.vercel.app).
//  전부 등록할 수 없으므로 프리뷰에선 채널이 안 뜨는 게 정상이다. 고정 주소에서만 쓴다.
const ALLOWED_ORIGINS = [
  "https://youtube-feed-mu.vercel.app", // 현재 배포처 (2026-08-16~)
  // 2026-08-25: 옛 배포처(emithen.github.io)를 지웠다. 데이터 이사는 08-17에 끝났고,
  //  남겨두는 것이 이제 위험이었다 — 옛 사이트에서 ☁️ 올리기를 누르면 낡은 데이터가
  //  드라이브를 덮는다. 같은 날 gh-pages 브랜치도 지워서 그 주소는 이제 404다.
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
        // 판정(state)에 따라 캐시 지시를 달리하지 않는다 — 애초에 캐시하지 않는다.
        // 왜 그렇게 정했는지는 corsHeaders에 적어뒀다.
        return json({ channelId, ...feed }, 200, cors);
      }

      return json({ error: "없는 경로" }, 404, cors);
    } catch (e) {
      // 여기까지 내려오는 것은 **답을 못 낸 경우뿐이다.**
      // "채널이 죽었다"·"영상이 없다"는 위에서 200으로 답하고 이리로 오지 않는다.
      const status = e instanceof NotFound ? 404 : 502;
      // 실패는 캐시하지 않는다 — 일시적 장애가 굳어버리면 안 되니까. 2026-08-21부터
      // **성공도 캐시하지 않으므로**(corsHeaders 참고) 여기만 따로 지정할 것이 없어졌다.
      return json({ error: String(e.message || e) }, status, cors);
    }
  },
};

// 입력을 채널로 해석하지 못했다. 릴레이는 멀쩡하고 **요청이 틀린 것**이라 404로 답한다.
// (채널이 삭제된 것과는 다르다 — 그건 해석은 됐고 실제로 사라진 경우라 200 + state:"gone".)
class NotFound extends Error {}

// ────────────────────────── CORS ──────────────────────────
// ⭐ **캐시 지시는 하나뿐이다: 저장하지 마라** (2026-08-21).
//  경로별로 다른 TTL을 주던 것을 없앴다. 판정마다 수명을 달리 매기는 건 "이 답은 틀릴 수
//  있으니 피해 시간을 깎자"는 뜻이라, **틀린 답을 싸게 만들 뿐 답을 맞히지 못한다.**
//  맞히는 일은 confirmGone이 하고, 여기서는 규칙을 하나로 둔다.
function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    // ⚠️ 응답의 CORS 헤더가 Origin마다 다르므로, 저장된다면 Origin별로 나뉘어야 한다.
    //  (없어서 localhost 응답이 github.io 요청에 재사용돼 CORS 불일치로 죽은 적이 있다.)
    //  지금은 no-store라 저장될 일이 없지만, 캐시가 돌아오는 순간 다시 필수가 되므로 남긴다.
    "Vary": "Origin",
    // ⭐ **브라우저에 저장하지 않는다** (2026-08-21). 그전엔 `public, max-age=600`이었다.
    //  주석에 적힌 의도는 "같은 채널을 자주 부르면 캐시가 대신 답한다(유튜브 부담·속도)"였는데,
    //  근거 둘 다 이미 다른 층에 있었다:
    //   · 유튜브 부담 … getText의 엣지 캐시(cf.cacheTtl)가 막는다. 여기가 없어도 유튜브엔 안 간다.
    //     (실측: 핸들 경로가 1.20s → 0.47s로 내려앉는다 = 1.6MB를 통째로 건너뛰고 있다)
    //   · 속도      … localStorage 캐시가 즉시 그린다. 이 층이 아끼는 왕복 0.45s 동안
    //                 화면엔 이미 영상이 떠 있다.
    //  게다가 **전제가 틀렸다**: 화면은 claimLoad 때문에 한 epoch에 채널당 딱 한 번만 부른다.
    //  "자주 부르는" 일이 없으니 두 번째 호출을 위한 캐시가 발동할 자리도 없다.
    //  실제로 발동하는 순간은 **사용자가 새로고침했을 때** — 즉 새 데이터를 달라고 명시한
    //  바로 그 순간이다. 2026-08-21에 오진된 gone이 F5로도 안 풀리고 10분간 굳은 게 이것이다.
    //  → 남는 순효과가 "다시 물어보지 못하게 막는 것"뿐이라 걷어냈다.
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
    // ⚠️ **2026-08-21에 뒤집었다.** 그전엔 여기서 바로 `state:"gone"`을 확정했다.
    //  전제는 "RSS의 404 = 채널이 삭제됐다"였는데 **그 전제가 틀렸다.** 유튜브 RSS는
    //  일시 과부하·스로틀링에도 404를 준다. 같은 채널에 20번 쏴서 200이 0~3번 나왔고,
    //  본문까지 비교했지만 진짜 없는 채널의 404와 **1613바이트 중 URL 한 줄만 다르다**
    //  — 응답만 보고 가르는 방법이 원리적으로 없다.
    //  → 404는 이제 **증거이지 증명이 아니다.** 확정은 confirmGone이 따로 받아온다.
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

// ────────────────────────── RSS 404의 진위 확인 ──────────────────────────
// RSS가 404를 줬을 때 **다른 문으로 같은 질문을 한 번 더 한다.**
//
// ⭐ 재시도가 아니라 **다른 엔드포인트에 묻는 것**이라는 게 핵심이다. 같은 문을 또
//  두드리면 같은 확률로 또 틀린다 — 확률을 확정으로 바꿀 수 없다. 채널 페이지는 RSS와
//  별개로 서비스되고, 2026-08-21 장애 때 RSS가 0/20인 동안 10/10 멀쩡했다.
//
// ⚠️ 채널 페이지는 **없는 채널에도 200을 준다**(소프트 404). 본문에
//  `"alerts":[{"alertRenderer":{"type":"ERROR","text":{"simpleText":"존재하지 않는 채널입니다."}}}]`
//  을 실어 보낼 뿐이다. **상태코드만 보면 안 되고 본문의 표지를 봐야 한다.**
//
// ⚠️ 표지로 `"channelId":"`를 쓰면 안 된다. 죽은 채널 페이지에도 그게 딱 하나 있는데
//  **우리가 URL로 보낸 그 ID가 되울려 나온 것**이다(에코 — UCzzz…를 넣으면 UCzzz…가 나온다).
//  resolveChannelId의 최후 수단이 하필 그 마커인데, 그 함수는 핸들일 때만 불리고 없는
//  핸들은 진짜 404를 받아서 지금까지 안 터졌을 뿐이다. 경로가 안 닿았을 뿐 로직은 틀려 있다.
//  → 여기서는 **살아있는 페이지에만 있는 표지**(canonical·externalId)만 본다.
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
