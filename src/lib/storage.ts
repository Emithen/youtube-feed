// storage.ts — localStorage에 저장되는 모든 것.
//
// 왜 한 곳에 모았나:
//  키가 파일 여기저기에 흩어져 있으면 "이 앱이 저장하는 게 전부 뭐지?"에 답할 수 없다.
//  다음 두 작업이 하필 그 질문을 정면으로 묻는다:
//   ① 내보내기/가져오기 — 저장된 것 전부를 한 덩어리로 만들어야 한다
//   ② 로그인 → 서버 저장 — 저장 위치를 브라우저에서 서버로 갈아끼워야 한다
//  ②는 이 파일의 함수 속만 바꾸면 되도록, 화면은 localStorage를 직접 부르지 않는다.
//
// ⚠️ 브라우저 데이터를 지우면 전부 사라진다. 계정이 없으므로 복구 수단이 없다.
// ⚠️ **localStorage는 origin별로 격리된다.** 배포 주소가 바뀌면(github.io → Vercel)
//    새 주소에서는 전부 빈 상태로 보인다. 옮기는 수단이 드라이브 동기화다.

import type { Channel, ExportData, ExportPayload, PoolVideo, Video } from "./types";

export const KEYS = {
  channels: "myChannels", // 내가 추가한 채널 목록
  cache: "channelCache", // 채널별 최근 결과 (재방문 시 즉시 렌더용, 없어도 됨)
  subs: "subsCache", // 구독 목록 (고를 때만 쓰는 후보. 저장이 아니라 캐시다)
  watched: "watched", // 본 영상 { 영상ID: 본 시각 }
  pool: "laterPool", // 나중에 볼 풀 { 영상ID: {...영상, addedAt, source} }
  playlistId: "playlistId", // watchme 재생목록 ID
} as const;

// ⚠️ **이 파일이 관리하지 않는 키가 하나 있다: `authToken`** (youtube.ts, 2026-08-15).
//  일부러 뺐다 — 토큰은 앱 데이터가 아니라 세션이고, 무엇보다 `exportAll`에 실리면
//  **드라이브에 올라가 버린다.** 여기 KEYS에 넣으면 그 사고가 한 줄 실수로 일어난다.
//  "이 앱이 저장하는 게 전부 뭐지?"의 답은 여전히 여기서 다 읽을 수 있게 이 주석을 남긴다.

const WATCHED_MAX = 1000; // 무한히 쌓이지 않게 상한 (넘으면 오래된 것부터 버림)

// 캐시 한 칸. state가 붙은 응답은 **여기 안 들어온다**(빈 배열이 굳으면 안 되니까).
type CacheEntry = { at: number; videos: Video[] };

// 깨진 값이 들어있어도 앱이 죽지 않게. localStorage는 사용자가 손댈 수 있는 곳이다.
function loadJSON<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

const saveJSON = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

// ────────────────────────── 내 채널 · 캐시 ──────────────────────────
export const loadChannels = (): Channel[] => loadJSON<Channel[]>(KEYS.channels, []);
export const saveChannels = (list: Channel[]) => saveJSON(KEYS.channels, list);
export const loadCache = (): Record<string, CacheEntry> => loadJSON(KEYS.cache, {});
export const saveCache = (c: Record<string, CacheEntry>) => saveJSON(KEYS.cache, c);

// ── 선별: 이 채널을 피드에 그릴지 ──
// ⭐ `active`가 **없는** 옛 데이터는 켜진 것으로 읽는다. 백업 계약과 같은 규칙(기존 필드는
//    그대로 두고 추가만)이라, 이미 저장된 채널을 한 줄도 안 고치고 그대로 살릴 수 있다.
//    그래서 이 기능을 켜도 첫 화면은 어제와 똑같다 — 끄기 전까지는 아무것도 안 변한다.
//
// ⭐ **2026-08-17에 뜻이 하나로 정리됐다.** 그전까지 `active`는 두 가지를 겸하고 있었다:
//     ① "구독에서 가져왔지만 아직 안 고른 후보"   ② "골랐지만 지금은 피드에서 빼기"
//   구독 목록이 저장 대상에서 빠지면서 ①이 사라졌다. 이제 `myChannels`는 **고른 것만**
//   담고, `active`는 ②만 뜻한다 — "내 채널인데 지금은 안 보기".
export const isActive = (ch: Channel) => ch.active !== false;

// 한 채널만 켜고 끈다.
export function setActive(channelId: string, on: boolean) {
  const list = loadChannels();
  const ch = list.find((c) => c.channelId === channelId);
  if (!ch) return;
  ch.active = on;
  saveChannels(list);
}

// 전부 켜기/끄기. 구독 319개를 손으로 끌 수는 없으니, 선별은 **전부 끄고 고르기**로 시작한다.
export function setAllActive(on: boolean) {
  saveChannels(loadChannels().map((c) => ({ ...c, active: on })));
}

// ── 구독 목록 캐시 ──
// ⭐ **저장이 아니라 캐시다.** 구독은 구글에 있는 것이고 우리는 "고를 때 잠깐 보여줄" 뿐이다.
//  그래서 `channelCache`와 **같은 지위**로 둔다 — localStorage에 있지만 `exportAll`에서 빠진다.
//  기존 규칙을 한 번 더 쓰는 것이다: **다시 만들 수 있는 것은 계약에 넣지 않는다.**
//
//  ⚠️ 구독을 *저장*하면 두 가지가 따라온다: ⓐ 드라이브로 실려 나가고
//   ⓑ 유튜브에서 구독을 끊어도 앱에 유령처럼 남는다. 캐시는 둘 다 없다.
export type CachedSubs = { at: number; items: { channelId: string; name: string }[] };

export const loadSubs = (): CachedSubs | null => loadJSON<CachedSubs | null>(KEYS.subs, null);
export const saveSubs = (items: CachedSubs["items"]) =>
  saveJSON(KEYS.subs, { at: Date.now(), items });

// 채널 하나의 최신 결과를 캐시에 넣는다 (렌더와 폼 양쪽에서 쓰던 3줄)
export function cacheChannel(channelId: string, videos: Video[]) {
  const c = loadCache();
  c[channelId] = { at: Date.now(), videos };
  saveCache(c);
}

// ────────────────────────── 본 영상 ──────────────────────────
export const loadWatched = (): Record<string, number> => loadJSON(KEYS.watched, {});

// 객체에 키가 있는지. 영상 ID가 "toString" 같은 값이어도 안전하도록 hasOwnProperty를 쓴다.
export const hasWatched = (map: Record<string, number>, id: string) =>
  Object.prototype.hasOwnProperty.call(map, id);

function saveWatched(w: Record<string, number>) {
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
export function markWatched(id: string) {
  const w = loadWatched();
  if (hasWatched(w, id)) return false;
  w[id] = Date.now();
  saveWatched(w);
  return true;
}

// 손으로 켜고 끄기 (실수로 클릭했을 때 되돌리기). → 바뀐 뒤 상태
export function toggleWatched(id: string) {
  const w = loadWatched();
  const on = hasWatched(w, id);
  if (on) delete w[id];
  else w[id] = Date.now();
  saveWatched(w);
  return !on;
}

// ────────────────────────── 나중에 볼 풀 ──────────────────────────
export const loadPool = (): Record<string, PoolVideo> => loadJSON(KEYS.pool, {});
export const savePool = (p: Record<string, PoolVideo>) => saveJSON(KEYS.pool, p);
export const clearPool = () => localStorage.removeItem(KEYS.pool);

export const loadPlaylistId = () => localStorage.getItem(KEYS.playlistId) || "";
export const savePlaylistId = (id: string) => localStorage.setItem(KEYS.playlistId, id);

// ────────────────────────── 내보내기 / 가져오기 ──────────────────────────
// 브라우저 데이터를 지우면 전부 사라지는 문제의 대비책이자, 기기끼리 잇는 수단이다.
// 이 함수 한 쌍이 주고받는 "JSON 한 장"이 그대로 드라이브에 올라간다 → drive.ts
//
// 원래는 파일로 내보내기/가져오기가 먼저 있었고 드라이브가 그 자리에 끼워졌다.
// 파일 쪽은 2026-08-07에 지웠지만 **이 함수들은 그대로다** — 저장 위치만 바뀌었을 뿐이라
// 애초에 여기엔 고칠 게 없었다. (계약을 밖에 둔 값을 여기서 한 번 더 돌려받은 셈)

export const EXPORT_VERSION = 1;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// ⚠️ `channelCache`와 `subsCache`는 **일부러 뺀다.** 둘 다 언제든 다시 만들 수 있는 것이라
// 옮길 가치가 없는데(Worker가·구글이 다시 준다) 크기는 제일 크다.
// → *다시 만들 수 있는 것은 계약에 넣지 않는다.*
export function exportAll(): ExportPayload {
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

// ══ 받아온 백업을 이 기기에 적용한다 ══
//
// ⭐ **덮어쓰기 하나뿐이다**(2026-08-15). 동기화는 "누른 쪽이 통째로 이긴다"로 통일했다:
//     올리기   … exportAll() 을 그대로 드라이브에 쓴다 (화면)
//     내려받기 … replaceAll() 로 이 기기를 드라이브 그대로 만든다
//
// 합치기(importAll)가 있었으나 2026-08-15에 지웠다 — git 이력에 있다.
// ⚠️ **지운 이유를 남겨둔다(같은 걸 다시 만들지 않으려고):** 합치기는 데이터가 절대 줄지
//  않아 안전했지만, 바로 그래서 **아무것도 지울 수 없었다.** 지운 채널이 클라우드에서
//  다시 딸려와 되살아나고, 그게 저장돼 클라우드에서도 영영 안 없어졌다.
//  선별(active)이 이 앱의 중심이 된 뒤로는 **"줄이는 것"이 곧 기능**이라, 줄일 수 없는
//  동기화는 쓸모가 없었다. 안전한 쪽이 늘 옳은 게 아니라 **무엇이 기능인지가 정한다.**
//
// ⚠️ 시각 기록이 없으므로 **마지막에 누른 쪽이 이긴다.** 어느 쪽이 더 새 것인지 앱은 모른다.
//  양쪽에서 번갈아 고치려면 필드별 시각이 필요하다(→ ROADMAP의 activeAt·tombstone).
//
// 백업 한 장을 검사해 쓸 수 있는 모양으로 돌려준다.
// 내용이 손상됐어도 읽을 수 있는 부분만 읽는다 — 모양이 틀린 항목은 조용히 건너뛴다.
function readPayload(payload: unknown) {
  if (!isObj(payload) || !isObj(payload.data)) {
    throw new Error("백업 데이터 모양이 아니야 (data 없음)");
  }
  if (payload.version !== EXPORT_VERSION) {
    throw new Error(`모르는 백업 버전이야 (${(payload.version as string) ?? "표기 없음"})`);
  }
  const d = payload.data;
  // 한 번씩 지역 변수로 받아서 좁힌다 — 인덱스 접근은 삼항 안에서 타입이 안 좁혀진다.
  const rawChannels = d[KEYS.channels];
  const rawWatched = d[KEYS.watched];
  const rawPool = d[KEYS.pool];
  const rawPlaylist = d[KEYS.playlistId];
  return {
    inChannels: Array.isArray(rawChannels) ? (rawChannels as unknown[]) : [],
    inWatched: isObj(rawWatched) ? rawWatched : {},
    inPool: isObj(rawPool) ? rawPool : {},
    inPlaylist: typeof rawPlaylist === "string" ? rawPlaylist : "",
  };
}

// 저장된 채널 한 줄을 세운다. 받아온 값이 손상돼 있어도 모양을 보장한다.
// `active`는 **false일 때만** 싣는다 — "필드 없음 = 켜짐" 규약을 한 갈래로 두려고.
function channelFrom(c: Record<string, unknown>): Channel {
  const channelId = c.channelId as string;
  const ch: Channel = {
    topic: (c.topic as string) || "내 채널",
    name: (c.name as string) || channelId,
    channelId,
  };
  if (c.active === false) ch.active = false;
  return ch;
}

// 이 기기를 백업 그대로 만든다. 합치지 않는다 — **클라우드에 없는 것은 지운다.**
// ⚠️ 되돌릴 수 없다. 부르는 쪽이 **무엇이 얼마나 줄어드는지 보여주고 확인을 받아야 한다.**
// `channelCache`는 건드리지 않는다 — 채널ID로 찾는 캐시라 지워진 채널 몫은 아무도 안 읽고,
//  남겨두면 다시 켰을 때 즉시 그려진다(Worker가 언제든 다시 만들어주는 것이기도 하다).
export function replaceAll(payload: unknown) {
  const { inChannels, inWatched, inPool, inPlaylist } = readPayload(payload);

  const channels: Channel[] = [];
  for (const c of inChannels) {
    if (!isObj(c) || !c.channelId) continue;
    channels.push(channelFrom(c));
  }

  const watched: Record<string, number> = {};
  for (const [id, at] of Object.entries(inWatched)) {
    const t = Number(at);
    if (Number.isFinite(t)) watched[id] = t;
  }

  const pool: Record<string, PoolVideo> = {};
  for (const [id, v] of Object.entries(inPool)) {
    if (isObj(v)) pool[id] = v as unknown as PoolVideo;
  }

  saveChannels(channels);
  saveWatched(watched); // 상한(WATCHED_MAX) 적용도 여기서 같이 걸린다
  savePool(pool);
  savePlaylistId(inPlaylist); // 클라우드가 비어 있으면 이 기기도 비운다("그대로 만든다"이므로)

  return {
    channels: channels.length,
    watched: Object.keys(watched).length,
    pool: Object.keys(pool).length,
  };
}

// 백업 payload의 data 한 덩어리를 세는 도구. 화면이 "몇 개가 사라지는지" 보여줄 때 쓴다.
// ⚠️ 무엇을 담고 어떻게 덮어쓸지는 여기가 알고, **사람 말로 만드는 건 화면이 한다.**
export const countOf = (v: unknown) => (Array.isArray(v) ? v.length : Object.keys(v || {}).length);

// 부분적으로 손상된 payload도 세어야 하므로 ExportData가 아니라 느슨하게 받는다.
export type CountableData = Partial<Record<string, unknown>>;
export type { ExportData };
