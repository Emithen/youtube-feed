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

// ── 선별: 이 채널을 피드에 그릴지 ──
// ⭐ `active`가 **없는** 옛 데이터는 켜진 것으로 읽는다. 백업 계약과 같은 규칙(기존 필드는
//    그대로 두고 추가만)이라, 이미 저장된 채널을 한 줄도 안 고치고 그대로 살릴 수 있다.
//    그래서 이 기능을 켜도 첫 화면은 어제와 똑같다 — 끄기 전까지는 아무것도 안 변한다.
export const isActive = (ch) => ch.active !== false;

// 한 채널만 켜고 끈다.
export function setActive(channelId, on) {
  const list = loadChannels();
  const ch = list.find((c) => c.channelId === channelId);
  if (!ch) return;
  ch.active = on;
  saveChannels(list);
}

// 전부 켜기/끄기. 구독 319개를 손으로 끌 수는 없으니, 선별은 **전부 끄고 고르기**로 시작한다.
export function setAllActive(on) {
  saveChannels(loadChannels().map((c) => ({ ...c, active: on })));
}

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

// ────────────────────────── 내보내기 / 가져오기 ──────────────────────────
// 브라우저 데이터를 지우면 전부 사라지는 문제의 대비책이자, 기기끼리 잇는 수단이다.
// 이 함수 한 쌍이 주고받는 "JSON 한 장"이 그대로 드라이브에 올라간다 → drive.js
//
// 원래는 파일로 내보내기/가져오기가 먼저 있었고 드라이브가 그 자리에 끼워졌다.
// 파일 쪽은 2026-08-07에 지웠지만 **이 함수들은 그대로다** — 저장 위치만 바뀌었을 뿐이라
// 애초에 여기엔 고칠 게 없었다. (계약을 밖에 둔 값을 여기서 한 번 더 돌려받은 셈)

export const EXPORT_VERSION = 1;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// channelCache는 일부러 뺀다. Worker가 언제든 다시 만들어주는 것이라 옮길 가치가 없는데
// 크기는 제일 크다. "없어도 되는 것"은 백업하지 않는다.
export function exportAll() {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    // localStorage 키를 그대로 쓴다 → 파일을 열어보면 저장소와 같은 모양이라 대조하기 쉽다
    data: {
      [KEYS.channels]: loadChannels(),
      [KEYS.watched]: loadWatched(),
      [KEYS.pool]: loadPool(),
      [KEYS.playlistId]: loadPlaylistId(),
    },
  };
}

// 합치기 규칙: **기존 것이 이긴다.**
//  이 기기에서 손본 주제·이름이나 더 먼저 담은 시각을, 받아온 것이 덮으면 안 된다.
//  덕분에 두 기기에서 번갈아 가져와도 데이터가 줄어들지 않는다(합집합).
// ⚠️ **알려진 한계(2026-08-15): 선별(active)은 "이미 있는 채널"엔 전파되지 않는다.**
//  이 규칙은 *쌓이는 것*(주제·이름·addedAt)에 맞게 만들어졌는데, active는 쌓이는 게 아니라
//  **선택**이라 합집합 논리가 안 맞는다. 그래서 지금 되는 건 이것뿐이다:
//    ✅ 한 기기에서 고르고 → **새 기기**에서 복원   ❌ 두 기기가 같은 채널을 이미 가진 경우
//  양방향으로 맞추려면 필드별 시각(activeAt)이 필요하다. **실제로 아플 때** 붙인다.
// ⭐ **합치기만 있다.** 예전엔 파일 가져오기에 "덮어쓰기" 선택지가 있었지만 파일 기능과 함께
//  2026-08-07에 지웠다. 드라이브는 어느 기기에서 눌러도 안전해야 해서 덮어쓰기를 쓰지 않는다.
export function importAll(payload) {
  if (!isObj(payload) || !isObj(payload.data)) throw new Error("백업 데이터 모양이 아니야 (data 없음)");
  if (payload.version !== EXPORT_VERSION) {
    throw new Error(`모르는 백업 버전이야 (${payload.version ?? "표기 없음"})`);
  }
  const d = payload.data;

  // 내용이 손상됐어도 읽을 수 있는 부분만 읽는다. 모양이 틀린 항목은 조용히 건너뛴다.
  const inChannels = Array.isArray(d[KEYS.channels]) ? d[KEYS.channels] : [];
  const inWatched = isObj(d[KEYS.watched]) ? d[KEYS.watched] : {};
  const inPool = isObj(d[KEYS.pool]) ? d[KEYS.pool] : {};
  const inPlaylist = typeof d[KEYS.playlistId] === "string" ? d[KEYS.playlistId] : "";

  const channels = loadChannels();
  const watched = loadWatched();
  const pool = loadPool();
  const added = { channels: 0, watched: 0, pool: 0 };

  const have = new Set(channels.map((c) => c.channelId));
  for (const c of inChannels) {
    if (!isObj(c) || !c.channelId || have.has(c.channelId)) continue;
    const ch = {
      topic: c.topic || "내 채널",
      name: c.name || c.channelId,
      channelId: c.channelId,
    };
    // ⭐ 선별(active)도 같이 옮긴다. 안 옮기면 **새 기기에서 복원할 때 319개가 전부 켜진 채로**
    //    살아나 골라둔 것이 통째로 날아간다(2026-08-15에 실측으로 확인).
    //    `false`일 때만 싣는 이유: "필드 없음 = 켜짐" 규약을 그대로 두려고. 데이터도 안 늘어난다.
    if (c.active === false) ch.active = false;
    channels.push(ch);
    have.add(c.channelId);
    added.channels++;
  }

  for (const [id, at] of Object.entries(inWatched)) {
    const t = Number(at);
    if (!Number.isFinite(t)) continue;
    if (!hasWatched(watched, id)) {
      watched[id] = t;
      added.watched++;
    } else if (t < watched[id]) {
      watched[id] = t; // 같은 영상이면 **먼저 본 시각**이 사실에 가깝다
    }
  }

  for (const [id, v] of Object.entries(inPool)) {
    if (!isObj(v) || pool[id]) continue; // 이미 있으면 그대로 — addedAt을 지킨다
    pool[id] = v;
    added.pool++;
  }

  saveChannels(channels);
  saveWatched(watched); // 상한(WATCHED_MAX) 적용도 여기서 같이 걸린다
  savePool(pool);
  if (inPlaylist && !loadPlaylistId()) {
    savePlaylistId(inPlaylist); // 비어 있을 때만 채운다 (이 기기 설정이 우선)
  }

  return added;
}
