// app.js — 내가 추가한 채널(localStorage)의 최신 영상을 그린다.
//
// 2026-07-28: 추천 채널(data.json) 렌더를 제거했고, 2026-07-31에 파일(collect.py·data.json)도 지웠다.
//  지금은 화면이 "내 채널" 하나뿐이다. 되살릴 일이 생기면 git 이력에서 꺼내온다:
//  git show <삭제 직전 커밋>:collect.py > collect.py
//
// 내 채널 데이터는 내 Cloudflare Worker가 가져다준다.
//  브라우저가 유튜브 RSS를 직접 fetch하면 CORS에 막히므로 중간 릴레이가 필요한데,
//  예전엔 공개 무료 프록시를 썼다가 레이트 리밋으로 "3연속 실패"가 잦아 내 Worker로 바꿨다.
//  Worker가 @핸들 해결과 XML 파싱까지 끝내주므로, 여기서는 JSON만 받아 그리면 된다.
//  (코드: worker/rss-proxy.js)
//
// 2026-07-31 모듈 분리 — 이 파일은 "화면"만 담당한다:
//  worker.js  … Worker를 부르는 유일한 창구 (URL 조립·에러 규약·50개씩 쪼개기)
//  storage.js … localStorage에 저장되는 모든 것 (키·읽기·쓰기)
//  youtube.js … 구글 로그인(OAuth) + 유튜브 Data API 직접 호출 (2026-07-31 추가)
//  app.js     … 이 파일. DOM을 만들고 이벤트를 붙인다. fetch도 localStorage도 직접 안 쓴다.

// ?v= 는 import에도 붙인다 — index.html의 ?v=만으로는 이 파일들의 캐시가 갈리지 않는다.
// (새 app.js + 캐시된 옛 worker.js 조합으로 깨지는 사고를 막는다. 버전 올릴 땐 아래 두 줄도 같이.)
import * as worker from "./worker.js?v=12";
import * as store from "./storage.js?v=12";
import * as yt from "./youtube.js?v=12";

// 재생목록·영상 조회는 **로그인했으면 유튜브를 직접** 부른다(쿼터가 내 것이고 비공개도 읽힌다).
// 로그인 전에는 Worker의 API 키 경로로 떨어진다 — OAuth 경로가 폰에서 검증되면 이 폴백을 없앤다.
// 두 모듈이 같은 모양을 돌려주기 때문에 이렇게 갈아끼우는 게 가능하다(계약의 값어치).
const source = () => (yt.isSignedIn() ? yt : worker);

const NEW_WINDOW_MS = 24 * 60 * 60 * 1000; // 이 시간 안에 올라온 영상에 NEW 배지

// 영상 식별자. Worker가 주는 id를 쓰되, 아직 구버전 Worker라면 링크에서 뽑는다.
// (watch?v=ID / shorts/ID / youtu.be/ID 모두 대응 → 배포 순서에 상관없이 동작)
function videoKey(v) {
  if (v.id) return v.id;
  const m = String(v.link || "").match(/(?:v=|\/shorts\/|youtu\.be\/)([\w-]{6,})/);
  return m ? m[1] : v.link;
}

// 24시간 이내 업로드인가. published(시각까지)가 정확하고,
// 없으면(구버전 Worker가 만든 캐시) date(날짜만)로 대략 판단한다.
function isNew(v) {
  const t = Date.parse(v.published || v.date || "");
  return Number.isFinite(t) && Date.now() - t < NEW_WINDOW_MS;
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

  // 목록 전체가 같은 기록을 쓰므로 한 번만 읽는다 (영상마다 읽으면 낭비)
  const watched = store.loadWatched();

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
      paint(store.hasWatched(watched, key));

      // 눌러서 수동으로 켜고 끄기 (실수로 클릭했을 때 되돌리기)
      mark.addEventListener("click", () => {
        paint(store.toggleWatched(key));
        refreshPoolCount(); // 이 영상이 풀에도 있으면 "안 본 것" 수가 바뀐다
      });

      // 영상을 클릭해 열면 자동으로 "봤음" 기록 (마찰 0)
      a.addEventListener("click", () => {
        if (store.markWatched(key)) {
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
  const list = store.loadChannels();
  const cache = store.loadCache();
  box.replaceChildren();
  if (list.length === 0) {
    box.appendChild(emptyStateEl());
    return;
  }

  box.appendChild(groupLabel("— 내 채널 —"));

  for (const ch of list) {
    const onDelete = () => {
      store.saveChannels(store.loadChannels().filter((c) => c.channelId !== ch.channelId));
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
    worker.fetchChannel(ch.channelId)
      .then((data) => {
        store.cacheChannel(ch.channelId, data.videos);
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
      const data = await worker.fetchChannel(input);

      const list = store.loadChannels();
      if (list.some((c) => c.channelId === data.channelId)) {
        status.textContent = "이미 추가된 채널이야.";
        return;
      }
      const topic = document.getElementById("chTopic").value.trim() || "내 채널";
      const name = document.getElementById("chName").value.trim() || data.name;

      list.push({ topic, name, channelId: data.channelId });
      store.saveChannels(list);

      // 방금 받은 영상을 바로 캐시에 넣어 두면 렌더가 즉시 뜬다
      store.cacheChannel(data.channelId, data.videos);

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

function poolStats() {
  const pool = store.loadPool();
  const watched = store.loadWatched();
  const all = Object.keys(pool);
  const left = all.filter((k) => !store.hasWatched(watched, k));
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
  const pool = store.loadPool();
  let added = 0;
  for (const v of videos) {
    if (!v.id) continue;
    if (!pool[v.id]) {
      pool[v.id] = { ...v, addedAt: Date.now(), source };
      added++;
    }
  }
  store.savePool(pool);
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
  const v = store.loadPool()[key];

  const a = document.createElement("a");
  a.href = v.link;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = v.title;
  // 열어보면 본 것으로 기록 → 다음 뽑기 후보에서 자동으로 빠진다
  a.addEventListener("click", () => {
    if (store.markWatched(v.id)) refreshPoolCount();
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
  let added = 0, missing = 0;
  try {
    // 50개씩 쪼개 부르는 건 worker.js가 안다. 여기선 묶음마다 무엇을 할지만 정한다.
    await source().fetchVideosChunked(ids, (data, done) => {
      added += mergeIntoPool(data.videos || [], "watchlater");
      missing += (data.missing || []).length;
      status.textContent = `가져오는 중… ${done}/${ids.length}`;
    });
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
// URL을 붙여넣으면 list= 값만 꺼낸다. 순수 ID면 그대로 쓴다.
function normalizePlaylistId(s) {
  const m = String(s).match(/[?&]list=([\w-]+)/);
  return (m ? m[1] : String(s)).trim();
}

async function syncPlaylist() {
  const status = document.getElementById("poolStatus");
  const btn = document.getElementById("syncBtn");
  const id = normalizePlaylistId(document.getElementById("plInput").value);
  if (!id) {
    status.textContent = "재생목록 ID나 URL을 넣어줘.";
    return;
  }

  btn.disabled = true;
  status.textContent = "재생목록 읽는 중…";
  try {
    const data = await source().fetchPlaylist(id);
    const added = mergeIntoPool(data.videos || [], "playlist");
    store.savePlaylistId(id); // 정리된 ID로 저장 → 다음에 열면 자동으로 채워둠
    document.getElementById("plInput").value = id;
    status.textContent =
      `동기화 완료: ${data.count}개 중 ${added}개 새로 추가` +
      (data.skipped ? ` (비공개·삭제 ${data.skipped}개 제외)` : "");
  } catch (e) {
    // ID가 잘려서 실패하는 일이 잦다(URL에서 드래그로 복사하면 일부만 잡힘).
    // 그래서 실제로 쓴 ID와 길이를 같이 보여줘 스스로 알아채게 한다.
    // "못 찾음" 판정은 worker.js가 해준다(상태코드·메시지를 여기서 다시 뜯지 않는다).
    let hint = "";
    if (e.notFound) {
      hint =
        ` — 사용한 ID "${id}" (${id.length}자).` +
        " 재생목록 ID는 보통 18자나 34자야. 짧으면 복사하다 잘린 거니 URL을 통째로 붙여넣어줘." +
        " 길이가 맞다면 공개 범위를 '일부 공개'로 바꿔야 해(비공개는 읽을 수 없음).";
    }
    status.textContent = "실패: " + e.message + hint;
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
    store.clearPool();
    document.getElementById("pick").replaceChildren();
    document.getElementById("repickBtn").hidden = true;
    document.getElementById("poolStatus").textContent = "풀을 비웠어.";
    refreshPoolCount();
  });

  document.getElementById("plInput").value = store.loadPlaylistId();
  refreshPoolCount();
}

// ══════════════════════════ 구글 로그인 · 구독 가져오기 ══════════════════════════
// 로그인은 "내 유튜브 데이터를 읽을 인가"를 받는 것이다. 화면 데이터를 서버에 올리는 것과는 무관하다
// (그건 나중에 할 기기 동기화의 몫). 그래서 로그인 안 해도 앱은 지금까지처럼 전부 동작한다.

function wireAuth() {
  const btn = document.getElementById("authBtn");
  if (!btn) return;
  const status = document.getElementById("authStatus");
  const subsBtn = document.getElementById("subsBtn");

  // 로그인 상태가 바뀔 때마다 버튼 문구와 구독 버튼 노출을 맞춘다
  yt.onAuthChange((on) => {
    btn.textContent = on ? "로그아웃" : "구글 로그인";
    subsBtn.hidden = !on;
    if (on) status.textContent = "로그인됨 — 내 구독·재생목록을 직접 읽어요";
  });

  btn.addEventListener("click", async () => {
    if (yt.isSignedIn()) {
      yt.signOut();
      status.textContent = "로그아웃했어.";
      return;
    }
    btn.disabled = true;
    status.textContent = "구글 창을 여는 중…";
    try {
      status.textContent = (await yt.signIn()) ? "" : "로그인이 취소됐어.";
    } catch (e) {
      status.textContent = "실패: " + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  subsBtn.addEventListener("click", importSubscriptions);

  // 이미 동의한 적 있으면 창 없이 조용히 받아온다. 실패해도 아무 말 안 한다(로그인은 선택이니까).
  yt.signIn({ silent: true }).catch(() => {});
}

// 구독 채널 → 내 채널 목록. 이미 있는 건 건드리지 않는다(주제·이름을 손봤을 수 있으니).
async function importSubscriptions() {
  const btn = document.getElementById("subsBtn");
  const status = document.getElementById("subsStatus");
  btn.disabled = true;
  status.textContent = "구독 목록 읽는 중…";
  try {
    const subs = await yt.fetchSubscriptions((got, total) => {
      status.textContent = `구독 목록 읽는 중… ${got}${total ? "/" + total : ""}`;
    });
    const list = store.loadChannels();
    const have = new Set(list.map((c) => c.channelId));
    let added = 0;
    for (const s of subs) {
      if (have.has(s.channelId)) continue;
      list.push({ topic: "구독", name: s.name, channelId: s.channelId });
      have.add(s.channelId);
      added++;
    }
    store.saveChannels(list);
    // 빠진 이유를 셈해서 알려준다 (조용히 사라지면 왜 개수가 다른지 알 수 없다)
    status.textContent =
      `구독 ${subs.length}개 중 ${added}개 추가` +
      (subs.length - added > 0 ? ` (이미 있던 것 ${subs.length - added}개)` : "");
    renderMyChannels();
  } catch (e) {
    status.textContent = e.needsAuth ? "로그인이 필요해." : "실패: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ────────────────────────── 시작 ──────────────────────────
renderMyChannels();
wireForm();
wirePool();
wireAuth();
