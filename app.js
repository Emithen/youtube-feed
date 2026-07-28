// app.js — 추천 채널(data.json) + 내가 추가한 채널(localStorage)을 합쳐 화면을 그린다.
//
// 왜 프록시가 필요한가:
//  사용자가 추가한 채널의 최신 영상은 "지금 이 순간" 브라우저에서 가져와야 한다.
//  그런데 유튜브 RSS를 브라우저에서 바로 fetch하면 CORS에 막힌다.
//  → 공개 CORS 프록시가 RSS를 대신 받아다 준다. (언젠가 불안정하면 PROXY만 바꾸거나
//    내 서버리스 함수로 승급하면 되고, 이 파일의 나머지 로직은 그대로 재사용된다.)

// 릴레이 후보들. 앞에서부터 시도해 처음 성공하는 걸 쓴다.
// (공개 프록시는 종종 죽는다 — 실제로 개발 중 allorigins가 500을 뱉었다.
//  하나가 죽어도 다음으로 넘어가게 여러 개를 둔다. 언젠가 자주 아프면 내 서버리스로 승급.)
const PROXIES = [
  (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  (u) => "https://api.codetabs.com/v1/proxy/?quest=" + u,
];
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

// ────────────────────────── 프록시로 텍스트 가져오기 ──────────────────────────
async function proxyText(url) {
  let lastErr;
  for (const make of PROXIES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000); // 12초 넘으면 다음 프록시로
      const res = await fetch(make(url), { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error("HTTP " + res.status);
        continue;
      }
      const text = await res.text();
      if (text) return text;
      lastErr = new Error("빈 응답");
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("모든 프록시 실패 (" + (lastErr ? lastErr.message : "?") + ")");
}

// ── 입력(채널ID / 채널URL / @핸들) → channel_id(UC...) ──
async function resolveChannelId(input) {
  const raw = input.trim();
  // 1) 이미 channel_id 형태
  if (/^UC[\w-]{20,}$/.test(raw)) return raw;
  // 2) URL 안에 /channel/UC... 가 들어있음
  const inUrl = raw.match(/channel\/(UC[\w-]{20,})/);
  if (inUrl) return inUrl[1];
  // 3) @핸들 또는 커스텀 URL → 채널 페이지 HTML을 긁어 channelId 추출
  let pageUrl = raw;
  if (raw.startsWith("@")) pageUrl = "https://www.youtube.com/" + raw;
  else if (!/^https?:\/\//.test(raw)) pageUrl = "https://www.youtube.com/@" + raw;
  const html = await proxyText(pageUrl);
  const hit =
    html.match(/"channelId":"(UC[\w-]{20,})"/) ||
    html.match(/channel\/(UC[\w-]{20,})/);
  if (!hit) throw new Error("채널 ID를 못 찾았어 (링크를 확인해줘)");
  return hit[1];
}

// ── channel_id → RSS XML 문서 ──
async function fetchFeed(channelId) {
  const rss = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const text = await proxyText(rss);
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("RSS 파싱 실패");
  return xml;
}

// ── RSS 문서 → 최신 영상 [{title, link, date}] ──
function parseVideos(xml) {
  return [...xml.getElementsByTagName("entry")].slice(0, LIMIT).map((e) => ({
    title: e.getElementsByTagName("title")[0]?.textContent || "(제목 없음)",
    link: e.getElementsByTagName("link")[0]?.getAttribute("href") || "#",
    date: (e.getElementsByTagName("published")[0]?.textContent || "").slice(0, 10),
  }));
}

// ── channel_id → 채널명 (RSS 루트의 title). 사용자가 이름을 안 적었을 때 자동 채움 ──
async function fetchChannelName(channelId) {
  try {
    const xml = await fetchFeed(channelId);
    return xml.querySelector("feed > title")?.textContent || null;
  } catch {
    return null;
  }
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

// ── 추천 채널: data.json ──
function renderPresets() {
  const box = document.getElementById("preset");
  fetch("data.json")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((data) => {
      document.getElementById("updated").textContent =
        "업데이트: " + data.updated + " (KST)";
      box.replaceChildren(groupLabel("— 추천 채널 —"));
      for (const s of data.sections) box.appendChild(sectionEl(s.topic, s.name, s.videos));
    })
    .catch((err) => {
      document.getElementById("updated").textContent = "추천 채널 로드 실패: " + err;
    });
}

// ── 내 채널: localStorage + 프록시 fetch (캐시 먼저 → 백그라운드 갱신) ──
function renderMyChannels() {
  const box = document.getElementById("my");
  const list = loadMyChannels();
  const cache = loadCache();
  box.replaceChildren();
  if (list.length === 0) return;

  box.appendChild(groupLabel("— 내 채널 —"));

  for (const ch of list) {
    const onDelete = () => {
      saveMyChannels(loadMyChannels().filter((c) => c.channelId !== ch.channelId));
      renderMyChannels();
    };

    // 캐시가 있으면 즉시, 없으면 "불러오는 중" 자리표시자
    const cached = cache[ch.channelId];
    let el = sectionEl(
      ch.topic,
      ch.name,
      cached ? cached.videos : [{ title: "불러오는 중…", link: "#", date: "" }],
      { onDelete }
    );
    box.appendChild(el);

    // 백그라운드로 최신 fetch → 성공하면 캐시 갱신 + 화면 교체
    fetchFeed(ch.channelId)
      .then((xml) => {
        const videos = parseVideos(xml);
        const c = loadCache();
        c[ch.channelId] = { at: Date.now(), videos };
        saveCache(c);
        const fresh = sectionEl(ch.topic, ch.name, videos, { onDelete });
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
  const status = document.getElementById("addStatus");
  const submitBtn = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chInput").value;
    if (!input.trim()) return;

    submitBtn.disabled = true;
    // 채널ID가 아니면 페이지를 긁어 ID를 찾느라 좀 걸린다 → 멈춘 줄 오해 안 하게 안내
    const looksLikeId = /^UC[\w-]{20,}$/.test(input.trim()) || /channel\/UC/.test(input);
    status.textContent = looksLikeId ? "불러오는 중…" : "채널 확인 중… (링크·핸들은 몇 초 걸려요)";
    try {
      const channelId = await resolveChannelId(input);
      const list = loadMyChannels();
      if (list.some((c) => c.channelId === channelId)) {
        status.textContent = "이미 추가된 채널이야.";
        return;
      }
      const topic = document.getElementById("chTopic").value.trim() || "내 채널";
      const name =
        document.getElementById("chName").value.trim() ||
        (await fetchChannelName(channelId)) ||
        channelId;

      list.push({ topic, name, channelId });
      saveMyChannels(list);
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
renderPresets();
renderMyChannels();
wireForm();
