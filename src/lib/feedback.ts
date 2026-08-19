// feedback.ts — 의견을 내 서버(`/api/feedback`)로 보내는 유일한 창구.
//
// 경계는 worker.ts와 같다: **여기는 서버가 무엇을 아는지만 담는다.**
//  사용자에게 보여줄 한국어 문장은 화면이 만든다 (400의 이유만 서버 문장을 그대로 넘긴다 —
//  "1000자를 넘었어" 같은 건 고칠 사람이 읽어야 하는 말이라 서버가 쥐고 있는 게 맞다).
//
// ⭐ Worker와 다른 점 하나: **여기는 CORS가 없다.** 앱과 API가 같은 Vercel 주소에서
//  서빙되므로 같은 출처다. `/rss`가 남의 도메인이라 릴레이가 필요했던 것과 대비된다.

import type { AppError } from "./types";

export const KINDS = ["bug", "idea", "etc"] as const;
export type FeedbackKind = (typeof KINDS)[number];

export type FeedbackInput = {
  kind: FeedbackKind;
  body: string;
  nickname: string;
};

/** 화면만 아는 것들. 나머지(viewport·UA·빌드)는 여기서 붙인다. */
export type FeedbackContext = {
  screen: string;
  signedIn: boolean;
  channels: number;
};

// ⛔ **여기 없는 것이 중요하다**: 채널 목록·나중에 볼 풀·본 영상 기록은 안 보낸다.
//  그 사람이 무엇을 보는지는 개인정보다. **개수만** 보낸다.
// ⚠️ 무엇이 함께 가는지는 화면에 한 줄로 적어둔다 — 몰래 붙이면 그게 곧 사고다.
export function collectMeta(ctx: FeedbackContext) {
  return {
    screen: ctx.screen,
    signedIn: ctx.signedIn,
    channels: ctx.channels,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    ua: navigator.userAgent,
    // 빌드 해시. "어느 버전에서 난 일인지"를 못 알면 고친 뒤에도 같은 제보가 계속 온다.
    build: __BUILD__,
  };
}

/**
 * 의견 한 건을 보낸다.
 * 성공하면 아무것도 안 돌려준다. 실패는 throw — err.status가 뜻을 갖는다(400/429/500).
 */
export async function send(input: FeedbackInput, ctx: FeedbackContext): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, meta: collectMeta(ctx) }),
    });
  } catch (e) {
    // 네트워크가 아예 안 됐다(비행기 모드·서버 다운). 상태코드가 없으므로 0으로 둔다.
    const err: AppError = new Error((e as Error).message);
    err.status = 0;
    throw err;
  }

  if (res.ok) return;

  const data = (await res.json().catch(() => ({}))) as { error?: string };
  const err: AppError = new Error(data.error || "HTTP " + res.status);
  err.status = res.status;
  throw err;
}
