// worker.js — 내 Cloudflare Worker를 부르는 유일한 창구.
//
// 지금은 **RSS 채널 목록 전용**이다 (2026-07-31).
//  재생목록·영상 상세는 구글 로그인 뒤 브라우저가 유튜브를 직접 부른다 → youtube.js
//  RSS만 여기 남은 이유: 유튜브 RSS는 CORS를 허락하지 않아 릴레이가 꼭 필요하고,
//  대신 **로그인 없이도 되고 쿼터를 안 먹는다**. 채널 피드에는 이쪽이 계속 유리하다.
//
// 경계: **여기는 Worker가 무엇을 아는지만 담는다.**
//  사용자에게 보여줄 한국어 문장은 화면(app.js)이 만든다. 여기서는 판정(err.notFound)만 넘긴다.
//  이유: 같은 실패라도 어디서 났느냐에 따라 할 말이 다르다 (채널 추가 실패 vs 재생목록 동기화 실패).
//
// Worker 코드: worker/rss-proxy.js

const BASE = "https://yt-rss.javer1155.workers.dev";

export const LIMIT = 6; // 채널당 보여줄 최신 영상 수 (본 영상이 흐려지므로 3개는 너무 적었다)

// 모든 호출이 지나가는 길목. URL 조립·JSON 파싱·에러 규약을 여기서만 정한다.
async function get(path, params) {
  const res = await fetch(`${BASE}${path}?` + new URLSearchParams(params));
  // 에러 응답도 { error: "..." } 모양이라 일단 JSON으로 읽어본다.
  // 파싱 자체가 실패하면(HTML 에러 페이지 등) 빈 객체로 두고 아래에서 상태코드로 말한다.
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "HTTP " + res.status);
    // "못 찾음"은 화면마다 안내가 달라서 따로 표시해둔다 (예: 잘린 재생목록 ID 안내)
    err.notFound = res.status === 404 || /찾을 수 없|not ?found/i.test(err.message);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ch: 채널ID / @핸들 / 채널URL 아무거나. Worker가 알아서 해석한다.
// → { channelId, name, videos: [{id, title, link, date, published}] }
export const fetchChannel = (ch) => get("/rss", { ch, limit: LIMIT });
