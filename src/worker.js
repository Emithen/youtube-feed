// worker.js — 내 Cloudflare Worker를 부르는 유일한 창구.
//
// 왜 한 곳에 모았나:
//  예전엔 /rss는 함수로, /videos·/playlist는 버튼 핸들러 안에서 URL을 직접 조립했다.
//  그래서 "응답을 어떻게 해석하는가"(아래 get의 4줄)가 세 군데에 똑같이 복사돼 있었다.
//  Worker의 계약이 바뀌면 화면 코드를 뒤져야 하는 상태 → 여기만 고치면 되게 바꿨다.
//
// 경계: **여기는 Worker가 무엇을 아는지만 담는다.**
//  사용자에게 보여줄 한국어 문장은 화면(app.js)이 만든다. 여기서는 판정(err.notFound)만 넘긴다.
//  이유: 같은 실패라도 어디서 났느냐에 따라 할 말이 다르다 (채널 추가 실패 vs 재생목록 동기화 실패).
//
// Worker 코드: worker/rss-proxy.js

const BASE = "https://yt-rss.javer1155.workers.dev";

export const LIMIT = 6; // 채널당 보여줄 최신 영상 수 (본 영상이 흐려지므로 3개는 너무 적었다)
export const CHUNK = 50; // /videos는 51개부터 400을 준다 (Data API가 한 번에 50개까지)

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

// → { playlistId, count, skipped, videos: [...] }  (전체 순회, 최대 1000개)
export const fetchPlaylist = (id) => get("/playlist", { id });

// → { count, missing: [ID...], videos: [...] }
export const fetchVideos = (ids) => get("/videos", { ids: ids.join(",") });

// 50개 한도는 Worker가 정한 것이므로 "나눠 부르는 법"도 여기가 안다.
// 화면은 받은 묶음으로 무엇을 할지만 정하면 된다(onChunk).
export async function fetchVideosChunked(ids, onChunk) {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const data = await fetchVideos(ids.slice(i, i + CHUNK));
    onChunk(data, Math.min(i + CHUNK, ids.length)); // (받은 묶음, 여기까지 처리한 개수)
  }
}
