// storage.js — localStorage에 저장되는 모든 것.
//
// 왜 한 곳에 모았나:
//  키가 파일 여기저기에 흩어져 있으면 "이 앱이 저장하는 게 전부 뭐지?"에 답할 수 없다.
//  다음 두 작업이 하필 그 질문을 정면으로 묻는다:
//   ① 내보내기/가져오기 — 저장된 것 전부를 한 덩어리로 만들어야 한다
//   ② 로그인(Supabase, L4→L5) — 저장 위치를 브라우저에서 서버로 갈아끼워야 한다
//  ②는 이 파일의 함수 속만 바꾸면 되도록, 화면은 localStorage를 직접 부르지 않는다.
//
// ⚠️ 브라우저 데이터를 지우면 전부 사라진다. 계정이 없으므로 복구 수단이 없다.

export const KEYS = {
  channels: "myChannels", // 내가 추가한 채널 목록
  cache: "channelCache", // 채널별 최근 결과 (재방문 시 즉시 렌더용, 없어도 됨)
  watched: "watched", // 본 영상 { 영상ID: 본 시각 }
  pool: "laterPool", // 나중에 볼 풀 { 영상ID: {...영상, addedAt, source} }
  playlistId: "playlistId", // watchme 재생목록 ID
};

const WATCHED_MAX = 1000; // 무한히 쌓이지 않게 상한 (넘으면 오래된 것부터 버림)

// 깨진 값이 들어있어도 앱이 죽지 않게. localStorage는 사용자가 손댈 수 있는 곳이다.
function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

const saveJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));

// ────────────────────────── 내 채널 · 캐시 ──────────────────────────
export const loadChannels = () => loadJSON(KEYS.channels, []);
export const saveChannels = (list) => saveJSON(KEYS.channels, list);
export const loadCache = () => loadJSON(KEYS.cache, {});
export const saveCache = (c) => saveJSON(KEYS.cache, c);

// 채널 하나의 최신 결과를 캐시에 넣는다 (렌더와 폼 양쪽에서 쓰던 3줄)
export function cacheChannel(channelId, videos) {
  const c = loadCache();
  c[channelId] = { at: Date.now(), videos };
  saveCache(c);
}

// ────────────────────────── 본 영상 ──────────────────────────
export const loadWatched = () => loadJSON(KEYS.watched, {});

// 객체에 키가 있는지. 영상 ID가 "toString" 같은 값이어도 안전하도록 hasOwnProperty를 쓴다.
export const hasWatched = (map, id) => Object.prototype.hasOwnProperty.call(map, id);

function saveWatched(w) {
  const keys = Object.keys(w);
  if (keys.length > WATCHED_MAX) {
    keys
      .sort((a, b) => w[a] - w[b])
      .slice(0, keys.length - WATCHED_MAX)
      .forEach((k) => delete w[k]);
  }
  saveJSON(KEYS.watched, w);
}

// 이미 봤으면 아무것도 안 한다. → 새로 기록했으면 true (화면 갱신이 필요한지 알려준다)
export function markWatched(id) {
  const w = loadWatched();
  if (hasWatched(w, id)) return false;
  w[id] = Date.now();
  saveWatched(w);
  return true;
}

// 손으로 켜고 끄기 (실수로 클릭했을 때 되돌리기). → 바뀐 뒤 상태
export function toggleWatched(id) {
  const w = loadWatched();
  const on = hasWatched(w, id);
  if (on) delete w[id];
  else w[id] = Date.now();
  saveWatched(w);
  return !on;
}

// ────────────────────────── 나중에 볼 풀 ──────────────────────────
export const loadPool = () => loadJSON(KEYS.pool, {});
export const savePool = (p) => saveJSON(KEYS.pool, p);
export const clearPool = () => localStorage.removeItem(KEYS.pool);

export const loadPlaylistId = () => localStorage.getItem(KEYS.playlistId) || "";
export const savePlaylistId = (id) => localStorage.setItem(KEYS.playlistId, id);
