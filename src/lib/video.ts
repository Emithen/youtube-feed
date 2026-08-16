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

// 24시간 이내 업로드인가. published(시각까지)가 정확하고,
// 없으면(구버전 Worker가 만든 캐시) date(날짜만)로 대략 판단한다.
export function isNew(v: Video) {
  const t = Date.parse(v.published || v.date || "");
  return Number.isFinite(t) && Date.now() - t < NEW_WINDOW_MS;
}
