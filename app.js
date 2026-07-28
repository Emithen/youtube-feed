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
const LIMIT = 3; // 채널당 보여줄 최신 영상 수
const STORE_KEY = "myChannels"; // 내 채널 목록
const CACHE_KEY = "channelCache"; // 채널별 최근 결과 캐시(재방문 시 즉시 렌더)

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

  for (const v of videos) {
    const p = document.createElement("p");
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

// ────────────────────────── 시작 ──────────────────────────
renderMyChannels();
wireForm();
