// video.ts — 영상 한 편을 읽는 규칙. 화면 여러 곳이 같이 쓴다.

import type { Video } from "./types";

const NEW_WINDOW_MS = 24 * 60 * 60 * 1000; // 이 시간 안에 올라온 영상에 NEW 배지

// 영상 식별자. Worker가 주는 id를 쓰되, 아직 구버전 Worker라면 링크에서 뽑는다.
// (watch?v=ID / shorts/ID / youtu.be/ID 모두 대응 → 배포 순서에 상관없이 동작)
// ⭐ 2026-07-30에 이 폴백을 넣은 덕에 Worker와 화면을 따로 배포해도 본 영상 기록이
//    안 어긋났다. 링크에서 뽑은 값이 실제 videoId와 **같기 때문**이다.
export function videoKey(v: Video) {
  if (v.id) return v.id;
  const m = String(v.link || "").match(/(?:v=|\/shorts\/|youtu\.be\/)([\w-]{6,})/);
  return m ? m[1] : v.link;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 자정 기준 「며칠 전」. 시각을 몰라도 어긋나지 않는다.
function calendarDaysAgo(t: number) {
  const then = new Date(t);
  then.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - then.getTime()) / DAY_MS);
}

// 훑을 때 읽는 시간 표기. 원문(`2026-08-19`)을 그대로 두면 「며칠 전인가」를
// 목록마다 머리로 환산하게 된다 — 훑기가 느려지는 지점이라 화면 쪽에서 접는다.
//
// ⭐ **시각을 아는 것은 `published`(ISO8601)뿐이다.** `date`는 날짜만이라
//  UTC 자정으로 읽히고, 그걸 시간 단위로 세면 어제 올라온 것이 "17시간 전"으로
//  나온다(자정 + 시간대 차이). 그래서 「N시간 전」은 `published`가 있을 때만 쓰고,
//  그 아래로는 **달력 날짜 차이**로 센다. `isNew`가 쓰는 폴백과 같은 구조다.
//
// ⚠️ 상대 시각은 원래 값을 지운다 → 화면은 정확한 날짜를 `title`로 함께 단다.
export function relativeTime(v: Video) {
  const t = Date.parse(v.published || v.date || "");
  if (!Number.isFinite(t)) return v.date || "";

  if (v.published) {
    const hours = (Date.now() - t) / (60 * 60 * 1000);
    if (hours < 0) return "방금"; // 기기 시계가 앞서 있는 경우 — 음수를 보여주지 않는다
    if (hours < 1) return "방금";
    if (hours < 24) return `${Math.floor(hours)}시간 전`;
  }

  const days = calendarDaysAgo(t);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;

  const d = new Date(t);
  return d.getFullYear() === new Date().getFullYear()
    ? `${d.getMonth() + 1}월 ${d.getDate()}일`
    : `${String(d.getFullYear()).slice(2)}.${d.getMonth() + 1}.${d.getDate()}`;
}

// 정확한 시각. **상대 표기가 지운 정보를 여기 남긴다** (화면이 title 로 단다).
//
// ⚠️ `v.date` 를 그대로 쓰면 안 된다. Worker 가 `published.slice(0,10)` 으로 만든
//  **UTC 날짜**라, 한국시각 기준 오전 0~9시에 올라온 영상은 상대 표기(로컬 기준)와
//  **하루 어긋난다** — 실제로 「8월 10일」 옆에 「2026-08-09」가 뜨는 걸 확인했다.
//  상대 표기와 정확 표기는 **같은 출처에서** 만들어야 서로를 설명할 수 있다.
export function exactTime(v: Video) {
  const t = Date.parse(v.published || v.date || "");
  if (!Number.isFinite(t)) return v.date || "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // 시각은 published 가 있을 때만 안다. date 뿐이면 날짜까지가 아는 전부다.
  return v.published ? `${ymd} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ymd;
}

// 24시간 이내 업로드인가. published(시각까지)가 정확하고,
// 없으면(구버전 Worker가 만든 캐시) date(날짜만)로 대략 판단한다.
export function isNew(v: Video) {
  const t = Date.parse(v.published || v.date || "");
  return Number.isFinite(t) && Date.now() - t < NEW_WINDOW_MS;
}
