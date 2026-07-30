// app.js — 내가 추가한 채널(localStorage)의 최신 영상을 그린다.
//
// 2026-07-28: 추천 채널(data.json) 렌더를 제거했다. 지금은 화면이 "내 채널" 하나뿐이다.
//  수집기(collect.py)와 data.json은 저장소에 그대로 보관돼 있으니 되살리려면
//  renderPresets를 다시 붙이고 collect.yml의 cron을 켜면 된다.
//
// 내 채널 데이터는 내 Cloudflare Worker가 가져다준다.
//  브라우저가 유튜브 RSS를 직접 fetch하면 CORS에 막히므로 중간 릴레이가 필요한데,
//  예전엔 공개 무료 프록시를 썼다가 레이트 리밋으로 "3연속 실패"가 잦아 내 Worker로 바꿨다.
//  Worker가 @핸들 해결과 XML 파싱까지 끝내주므로, 여기서는 JSON만 받아 그리면 된다.
//  (코드: worker/rss-proxy.js)

const WORKER = "https://yt-rss.javer1155.workers.dev";
const LIMIT = 6; // 채널당 보여줄 최신 영상 수 (본 영상이 흐려지므로 3개는 너무 적었다)
const STORE_KEY = "myChannels"; // 내 채널 목록
const CACHE_KEY = "channelCache"; // 채널별 최근 결과 캐시(재방문 시 즉시 렌더)
const WATCHED_KEY = "watched"; // 본 영상: { 영상ID: 본 시각 }
const WATCHED_MAX = 1000; // 무한히 쌓이지 않게 상한 (넘으면 오래된 것부터 버림)
const NEW_WINDOW_MS = 24 * 60 * 60 * 1000; // 이 시간 안에 올라온 영상에 NEW 배지

// ────────────────────────── localStorage 헬퍼 ──────────────────────────
function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
const loadMyChannels = () => loadJSON(STORE_KEY, []);
const saveMyChannels = (list) => localStorage.setItem(STORE_KEY, JSON.stringify(list));
const loadCache = () => loadJSON(CACHE_KEY, {});
const saveCache = (c) => localStorage.setItem(CACHE_KEY, JSON.stringify(c));

// ────────────────────────── 본 영상 기록 ──────────────────────────
const loadWatched = () => loadJSON(WATCHED_KEY, {});

function saveWatched(w) {
  // 상한을 넘으면 오래 본 것부터 버린다 (기록이 무한정 커지지 않게)
  const keys = Object.keys(w);
  if (keys.length > WATCHED_MAX) {
    keys
      .sort((a, b) => w[a] - w[b])
      .slice(0, keys.length - WATCHED_MAX)
      .forEach((k) => delete w[k]);
  }
  localStorage.setItem(WATCHED_KEY, JSON.stringify(w));
}

// 영상 식별자. Worker가 주는 id를 쓰되, 아직 구버전 Worker라면 링크에서 뽑는다.
// (watch?v=ID / shorts/ID / youtu.be/ID 모두 대응 → 배포 순서에 상관없이 동작)
function videoKey(v) {
  if (v.id) return v.id;
  const m = String(v.link || "").match(/(?:v=|\/shorts\/|youtu\.be\/)([\w-]{6,})/);
  return m ? m[1] : v.link;
}

function isWatched(v, w) {
  return Object.prototype.hasOwnProperty.call(w, videoKey(v));
}

// 24시간 이내 업로드인가. published(시각까지)가 정확하고,
// 없으면(구버전 Worker가 만든 캐시) date(날짜만)로 대략 판단한다.
function isNew(v) {
  const t = Date.parse(v.published || v.date || "");
  return Number.isFinite(t) && Date.now() - t < NEW_WINDOW_MS;
}

// ────────────────────────── Worker 호출 ──────────────────────────
// ch: 채널ID / @핸들 / 채널URL 아무거나. Worker가 알아서 해석한다.
// → { channelId, name, videos: [{title, link, date}] }
async function fetchChannel(ch) {
  const url = `${WORKER}/rss?ch=${encodeURIComponent(ch)}&limit=${LIMIT}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

// ────────────────────────── 렌더 (프리셋/내채널 공통) ──────────────────────────
function sectionEl(topic, name, videos, opts = {}) {
  const wrap = document.createElement("div");

  const h2 = document.createElement("h2");
  h2.textContent = `[${topic}] ${name}`;
  if (opts.onDelete) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "삭제";
    del.addEventListener("click", opts.onDelete);
    h2.appendChild(del);
  }
  wrap.appendChild(h2);

  const watched = loadWatched();

  for (const v of videos) {
    const p = document.createElement("p");
    const key = videoKey(v);

    // NEW 배지는 줄 맨 앞에 둬야 목록을 훑을 때 눈에 띈다
    let badge = null;
    if (isNew(v)) {
      badge = document.createElement("span");
      badge.className = "new";
      badge.textContent = "NEW";
      p.appendChild(badge);
    }

    const a = document.createElement("a");
    a.href = v.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = v.title; // textContent라 제목 속 <, & 도 안전(XSS 방지)
    p.appendChild(a);

    if (v.date) {
      const s = document.createElement("small");
      s.textContent = " " + v.date;
      p.appendChild(s);
    }

    // 링크가 없는 자리표시자("불러오는 중"·실패)에는 본 영상 표시를 붙이지 않는다
    if (v.link && v.link !== "#") {
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "seen";

      const paint = (on) => {
        p.classList.toggle("watched", on);
        // 이미 본 영상이면 NEW를 감춘다 — 본 것이 우선. 안 그러면 본 영상이 계속 강조된다.
        if (badge) badge.hidden = on;
        mark.textContent = on ? "✓" : "○";
        mark.title = on ? "본 영상 — 눌러서 해제" : "안 본 영상 — 눌러서 봤음 표시";
        mark.setAttribute("aria-label", mark.title);
        mark.setAttribute("aria-pressed", String(on));
      };
      paint(isWatched(v, watched));

      // 눌러서 수동으로 켜고 끄기 (실수로 클릭했을 때 되돌리기)
      mark.addEventListener("click", () => {
        const w = loadWatched();
        const on = Object.prototype.hasOwnProperty.call(w, key);
        if (on) delete w[key];
        else w[key] = Date.now();
        saveWatched(w);
        paint(!on);
        refreshPoolCount(); // 이 영상이 풀에도 있으면 "안 본 것" 수가 바뀐다
      });

      // 영상을 클릭해 열면 자동으로 "봤음" 기록 (마찰 0)
      a.addEventListener("click", () => {
        const w = loadWatched();
        if (!Object.prototype.hasOwnProperty.call(w, key)) {
          w[key] = Date.now();
          saveWatched(w);
          paint(true);
          refreshPoolCount();
        }
      });

      p.appendChild(mark);
    }

    wrap.appendChild(p);
  }
  return wrap;
}

function groupLabel(text) {
  const p = document.createElement("p");
  p.className = "group";
  p.textContent = text;
  return p;
}

// ── 아직 채널이 없을 때 안내 (추천 채널을 없앤 뒤로 첫 화면이 비기 때문) ──
function emptyStateEl() {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = "아직 추가한 채널이 없어요. 위에서 채널 링크나 @핸들을 넣어 추가해보세요.";
  return p;
}

// ── 내 채널: localStorage 목록 → Worker로 최신 영상 (캐시 먼저 → 백그라운드 갱신) ──
function renderMyChannels() {
  const box = document.getElementById("my");
  if (!box) return;
  const list = loadMyChannels();
  const cache = loadCache();
  box.replaceChildren();
  if (list.length === 0) {
    box.appendChild(emptyStateEl());
    return;
  }

  box.appendChild(groupLabel("— 내 채널 —"));

  for (const ch of list) {
    const onDelete = () => {
      saveMyChannels(loadMyChannels().filter((c) => c.channelId !== ch.channelId));
      renderMyChannels();
    };

    // 캐시가 있으면 즉시 그리고, 없으면 자리표시자
    const cached = cache[ch.channelId];
    let el = sectionEl(
      ch.topic,
      ch.name,
      cached ? cached.videos : [{ title: "불러오는 중…", link: "#", date: "" }],
      { onDelete }
    );
    box.appendChild(el);

    // 백그라운드로 최신 받아 교체
    fetchChannel(ch.channelId)
      .then((data) => {
        const c = loadCache();
        c[ch.channelId] = { at: Date.now(), videos: data.videos };
        saveCache(c);
        const fresh = sectionEl(ch.topic, ch.name, data.videos, { onDelete });
        box.replaceChild(fresh, el);
        el = fresh;
      })
      .catch((err) => {
        if (!cached) {
          const fail = sectionEl(
            ch.topic,
            ch.name,
            [{ title: "(불러오기 실패: " + err.message + ")", link: "#", date: "" }],
            { onDelete }
          );
          box.replaceChild(fail, el);
          el = fail;
        }
      });
  }
}

// ────────────────────────── 채널 추가 폼 ──────────────────────────
function wireForm() {
  const form = document.getElementById("addForm");
  if (!form) return;
  const status = document.getElementById("addStatus");
  const submitBtn = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chInput").value.trim();
    if (!input) return;

    submitBtn.disabled = true;
    status.textContent = "확인 중…";
    try {
      // Worker가 채널 해석 + 최신 영상까지 한 번에 준다 (요청 1회)
      const data = await fetchChannel(input);

      const list = loadMyChannels();
      if (list.some((c) => c.channelId === data.channelId)) {
        status.textContent = "이미 추가된 채널이야.";
        return;
      }
      const topic = document.getElementById("chTopic").value.trim() || "내 채널";
      const name = document.getElementById("chName").value.trim() || data.name;

      list.push({ topic, name, channelId: data.channelId });
      saveMyChannels(list);

      // 방금 받은 영상을 바로 캐시에 넣어 두면 렌더가 즉시 뜬다
      const c = loadCache();
      c[data.channelId] = { at: Date.now(), videos: data.videos };
      saveCache(c);

      form.reset();
      status.textContent = `추가됨: ${name}`;
      renderMyChannels();
    } catch (err) {
      status.textContent = "실패: " + err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ══════════════════════════ 랜덤 추천 (나중에 볼 풀) ══════════════════════════
// 유튜브의 "나중에 볼"(WL)은 API로 못 읽는다(2016년부터 차단). 그래서 풀을 두 곳에서 채운다:
//  ① 일회성 가져오기 — WL 화면에서 뽑아온 영상 ID 목록을 붙여넣으면 Worker가 상세를 채워준다
//  ② watchme 재생목록 동기화 — 앞으로 담는 곳. Data API로 전체를 읽어온다
// 둘을 합친 풀에서 무작위 1개를 제시한다. 이미 본 영상은 후보에서 뺀다(watched 재사용).

const POOL_KEY = "laterPool"; // { 영상ID: {id,title,link,date,published,channel,addedAt,source} }
const PLAYLIST_KEY = "playlistId";
const CHUNK = 50; // Worker의 /videos 한 번에 보낼 수 있는 최대 개수

const loadPool = () => loadJSON(POOL_KEY, {});
const savePool = (p) => localStorage.setItem(POOL_KEY, JSON.stringify(p));

function poolStats() {
  const pool = loadPool();
  const watched = loadWatched();
  const all = Object.keys(pool);
  const left = all.filter((k) => !Object.prototype.hasOwnProperty.call(watched, k));
  return { total: all.length, left: left.length, leftKeys: left };
}

function refreshPoolCount() {
  const el = document.getElementById("poolCount");
  if (!el) return;
  const { total, left } = poolStats();
  el.textContent = total === 0 ? "비어 있음" : `안 본 것 ${left}개 / 전체 ${total}개`;
}

// 풀에 합치기. 이미 있는 건 그대로 두고(담은 시각 유지) 새 것만 넣는다.
function mergeIntoPool(videos, source) {
  const pool = loadPool();
  let added = 0;
  for (const v of videos) {
    if (!v.id) continue;
    if (!pool[v.id]) {
      pool[v.id] = { ...v, addedAt: Date.now(), source };
      added++;
    }
  }
  savePool(pool);
  refreshPoolCount();
  return added;
}

// ── 뽑기 ──
function pickRandom() {
  const box = document.getElementById("pick");
  const status = document.getElementById("poolStatus");
  const { total, left, leftKeys } = poolStats();
  box.replaceChildren();

  if (total === 0) {
    status.textContent = "풀이 비어 있어. 아래 '영상 채워넣기'로 먼저 담아줘.";
    return;
  }
  if (left === 0) {
    status.textContent = "안 본 영상이 없어! 전부 봤네 🎉";
    return;
  }
  status.textContent = "";

  const key = leftKeys[Math.floor(Math.random() * leftKeys.length)];
  const v = loadPool()[key];

  const a = document.createElement("a");
  a.href = v.link;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = v.title;
  // 열어보면 본 것으로 기록 → 다음 뽑기 후보에서 자동으로 빠진다
  a.addEventListener("click", () => {
    const w = loadWatched();
    if (!Object.prototype.hasOwnProperty.call(w, v.id)) {
      w[v.id] = Date.now();
      saveWatched(w);
      refreshPoolCount();
    }
  });
  box.appendChild(a);

  const meta = document.createElement("small");
  meta.className = "meta";
  meta.textContent = [v.channel, v.date].filter(Boolean).join(" · ");
  box.appendChild(meta);

  document.getElementById("repickBtn").hidden = false;
}

// ── ① ID 목록 가져오기 (50개씩 나눠서) ──
// 붙여넣기 형식을 가리지 않는다: JSON 배열, 줄바꿈, 쉼표, URL, 심지어 잘린 JSON까지.
// 요령 — 유튜브 영상 ID는 **항상 11자**([A-Za-z0-9_-]). 그래서
//  ① 단어문자·하이픈이 아닌 것(따옴표·대괄호·쉼표·줄바꿈·슬래시…)을 전부 구분자로 보고 쪼갠 뒤
//  ② 길이가 정확히 11인 토큰만 남긴다.
// 이렇게 하면 URL 속 "youtube"(7자)·"watch"(5자) 같은 조각은 자동으로 걸러진다.
function parseIds(text) {
  const seen = new Set();
  return String(text || "")
    .split(/[^\w-]+/)
    .filter((t) => /^[\w-]{11}$/.test(t) && !seen.has(t) && seen.add(t));
}

async function importIds() {
  const status = document.getElementById("poolStatus");
  const btn = document.getElementById("importBtn");
  const ids = parseIds(document.getElementById("idsInput").value);
  if (ids.length === 0) {
    status.textContent = "가져올 ID가 없어.";
    return;
  }

  btn.disabled = true;
  let added = 0, missing = 0, done = 0;
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const res = await fetch(`${WORKER}/videos?ids=${encodeURIComponent(chunk.join(","))}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      added += mergeIntoPool(data.videos || [], "watchlater");
      missing += (data.missing || []).length;
      done += chunk.length;
      status.textContent = `가져오는 중… ${done}/${ids.length}`;
    }
    status.textContent =
      `가져오기 완료: ${added}개 추가` +
      (missing ? ` (비공개·삭제 ${missing}개 제외)` : "") +
      (ids.length - added - missing > 0 ? ` (이미 있던 것 ${ids.length - added - missing}개)` : "");
    document.getElementById("idsInput").value = "";
  } catch (e) {
    status.textContent = "실패: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── ② watchme 재생목록 동기화 ──
async function syncPlaylist() {
  const status = document.getElementById("poolStatus");
  const btn = document.getElementById("syncBtn");
  const input = document.getElementById("plInput").value.trim();
  if (!input) {
    status.textContent = "재생목록 ID나 URL을 넣어줘.";
    return;
  }

  btn.disabled = true;
  status.textContent = "재생목록 읽는 중…";
  try {
    const res = await fetch(`${WORKER}/playlist?id=${encodeURIComponent(input)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    const added = mergeIntoPool(data.videos || [], "playlist");
    localStorage.setItem(PLAYLIST_KEY, input); // 다음에 열면 자동으로 채워둠
    status.textContent =
      `동기화 완료: ${data.count}개 중 ${added}개 새로 추가` +
      (data.skipped ? ` (비공개·삭제 ${data.skipped}개 제외)` : "");
  } catch (e) {
    status.textContent = "실패: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

function wirePool() {
  const pick = document.getElementById("pickBtn");
  if (!pick) return; // 화면 구조가 안 맞으면 조용히 스킵

  pick.addEventListener("click", pickRandom);
  document.getElementById("repickBtn").addEventListener("click", pickRandom);
  document.getElementById("importBtn").addEventListener("click", importIds);
  document.getElementById("syncBtn").addEventListener("click", syncPlaylist);
  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!confirm("풀을 비울까? (본 영상 기록은 남습니다)")) return;
    localStorage.removeItem(POOL_KEY);
    document.getElementById("pick").replaceChildren();
    document.getElementById("repickBtn").hidden = true;
    document.getElementById("poolStatus").textContent = "풀을 비웠어.";
    refreshPoolCount();
  });

  document.getElementById("plInput").value = localStorage.getItem(PLAYLIST_KEY) || "";
  refreshPoolCount();
}

// ────────────────────────── 시작 ──────────────────────────
renderMyChannels();
wireForm();
wirePool();
