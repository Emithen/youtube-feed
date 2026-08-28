// storage.ts — localStorage에 저장되는 모든 것.
//
// 키를 한 곳에 모으는 이유: "이 앱이 저장하는 게 전부 뭐지?"에 한 파일로 답하기 위해서다.
// 그래서 **화면은 localStorage를 직접 부르지 않는다** — 저장 위치를 서버로 갈아끼우는 일이
// 이 파일 안쪽 교체로 끝나야 한다.
//
// ⚠️ 브라우저 데이터를 지우면 전부 사라진다. 계정이 없으므로 복구 수단이 없다.
// ⚠️ **localStorage는 origin별로 격리된다.** 배포 주소가 바뀌면 새 주소에서는 전부 빈
//    상태로 보인다 — 옮기는 수단이 드라이브 동기화다.

import type { Channel, ExportData, ExportPayload, PoolVideo, Video } from "./types";

export const KEYS = {
  channels: "myChannels", // 내가 추가한 채널 목록
  cache: "channelCache", // 채널별 최근 결과 (재방문 시 즉시 렌더용, 없어도 됨)
  subs: "subsCache", // 구독 목록 (고를 때만 쓰는 후보. 저장이 아니라 캐시다)
  watched: "watched", // 본 영상 { 영상ID: 본 시각 }
  pool: "laterPool", // 나중에 볼 풀 { 영상ID: {...영상, addedAt, source} }
  playlistId: "playlistId", // watchme 재생목록 ID
  myFeedback: "myFeedback", // 내가 보낸 의견의 사본 (서버가 원본, 여기는 확인용)
  feedbackDraft: "feedbackDraft", // 보내다 만 글 (사람이 쓴 글을 네트워크가 먹으면 안 된다)
} as const;

// ⛔ **`authToken`은 여기 넣지 않는다** (youtube.ts가 따로 쥔다). 토큰은 앱 데이터가 아니라
//  세션이고, KEYS에 들어오는 순간 `exportAll`에 실려 **드라이브로 올라간다.**

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
// `active`는 뜻이 하나다: **"내 채널인데 지금은 안 보기".** `myChannels`에는 고른 것만 담긴다.
// ⭐ **필드가 없으면 켜진 것으로 읽는다** — 기존 필드는 두고 추가만 하는 규약이라,
//  이미 저장된 채널을 한 줄도 안 고치고 그대로 쓴다.
export const isActive = (ch: Channel) => ch.active !== false;

// 한 채널만 켜고 끈다.
export function setActive(channelId: string, on: boolean) {
  const list = loadChannels();
  const ch = list.find((c) => c.channelId === channelId);
  if (!ch) return;
  ch.active = on;
  saveChannels(list);
}

// 전부 켜기/끄기. 수백 개를 손으로 끌 수는 없으니, 선별은 **전부 끄고 고르기**로 시작한다.
export function setAllActive(on: boolean) {
  saveChannels(loadChannels().map((c) => ({ ...c, active: on })));
}

// ── 구독 목록 캐시 ──
// ⭐ **저장이 아니라 캐시다.** 구독은 구글에 있는 것이고 우리는 고를 때 잠깐 보여줄 뿐이라
//  `channelCache`와 같은 지위다 — localStorage에 있지만 `exportAll`에서 빠진다.
//  ⚠️ 저장으로 바꾸면 둘이 따라온다: ⓐ 드라이브로 실려 나가고 ⓑ 유튜브에서 구독을 끊어도
//   앱에 유령처럼 남는다.
export type CachedSubs = { at: number; items: { channelId: string; name: string }[] };

export const loadSubs = (): CachedSubs | null => loadJSON<CachedSubs | null>(KEYS.subs, null);
export const saveSubs = (items: CachedSubs["items"]) =>
  saveJSON(KEYS.subs, { at: Date.now(), items });

// 채널 하나의 최신 결과를 캐시에 넣는다 (렌더와 폼 양쪽에서 쓴다)
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

// ────────────────────────── 의견 ──────────────────────────
// ⚠️ 둘 다 `exportAll`에서 빠진다 — 넣으면 드라이브로 실려 나간다.
//  캐시들과 지위는 같지만 **이유는 다르다**: 원본이 내 서버에 있고 여기 건 사본이다.

export type SentFeedback = { at: number; kind: string; body: string };

export const loadMyFeedback = (): SentFeedback[] => loadJSON<SentFeedback[]>(KEYS.myFeedback, []);

// 최근 것이 위로. 20건만 남긴다 — 목록이 아니라 "방금 보낸 것 확인"이 목적이라 그 이상은 짐이다.
export function addMyFeedback(item: SentFeedback) {
  const list = [item, ...loadMyFeedback()].slice(0, 20);
  saveJSON(KEYS.myFeedback, list);
  return list;
}

// ⭐ 초안: **실패해도 입력한 글을 지우지 않는다.** 사람이 쓴 글을 네트워크 실패로 날리는 게
//  이 기능에서 낼 수 있는 최악의 사고다. 성공하면 즉시 지운다.
export type Draft = { kind: string; body: string; nickname: string };

export const loadDraft = (): Draft | null => loadJSON<Draft | null>(KEYS.feedbackDraft, null);
export const saveDraft = (d: Draft) => saveJSON(KEYS.feedbackDraft, d);
export const clearDraft = () => localStorage.removeItem(KEYS.feedbackDraft);

// ────────────────────────── 내보내기 / 가져오기 ──────────────────────────
// 브라우저 데이터를 지우면 전부 사라지는 문제의 대비책이자, 기기끼리 잇는 수단이다.
// 이 함수들이 주고받는 **"JSON 한 장"이 그대로 드라이브에 올라간다** → drive.ts

export const EXPORT_VERSION = 1;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// 담기지 않는 것이 넷이고, 빠지는 **이유가 두 갈래**다:
//  · `channelCache`·`subsCache` … *다시 만들 수 있는 것은 계약에 넣지 않는다*
//    (Worker가·구글이 다시 준다. 게다가 크기는 제일 크다)
//  · `myFeedback`·`feedbackDraft` … **원본이 내 서버에 있다.** 여기 건 사본이고,
//    초안은 이 기기에서 쓰다 만 글이라 다른 기기로 따라갈 이유가 없다
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
// ⭐ **동기화는 덮어쓰기 하나뿐이다 — 누른 쪽이 통째로 이긴다.**
//     올리기   … exportAll() 을 그대로 드라이브에 쓴다 (화면)
//     내려받기 … replaceAll() 로 이 기기를 드라이브 그대로 만든다
//
// ⛔ **합치기로 되돌리지 않는다.** 합치기는 데이터가 절대 줄지 않아 안전해 보이지만,
//  바로 그래서 **아무것도 지울 수 없다** — 지운 채널이 클라우드에서 다시 딸려와 되살아난다.
//  선별(active)이 중심인 앱에서는 **"줄이는 것"이 곧 기능**이다.
// ⚠️ 시각 기록이 없으므로 **마지막에 누른 쪽이 이긴다.** 어느 쪽이 더 새 것인지 앱은 모른다 —
//  양쪽에서 번갈아 고치려면 필드별 시각이 필요하다(→ ROADMAP의 activeAt·tombstone).

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
