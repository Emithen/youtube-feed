// api/feedback.ts — 의견 한 건을 받아 Neon에 넣는다. **이 앱의 첫 서버 코드다.**
//
// 지금까지 쓰기는 전부 남의 것이었다: 드라이브는 구글 API였고, Worker는 무상태 읽기
// 릴레이였다. 여기서 처음으로 **내가 만든 서버에 내 스키마로 쓴다.**
//
// ── 계약 (ROADMAP 3-b 절에서 먼저 정한 그대로) ──
//  POST /api/feedback
//  { kind: "bug"|"idea"|"etc", body: "…", nickname?: "", meta: {…} }
//  → 201 { ok: true }
//
//  실패는 **상태코드가 뜻을 갖는다** (2026-08-16 RSS 계약의 정신 그대로):
//   400  입력 문제 (비었음·너무 김·모르는 kind) → 사용자가 고칠 수 있다. 이유를 돌려준다
//   429  너무 자주 보냈다                      → "잠깐 뒤에 다시"
//   500  진짜 장애 (DB가 안 됨 등)             → 원인은 사용자 몫이 아니다
//  ⭐ 한국어 문장은 여기서 만들지 않는다 — 판정만 넘기고 말은 화면이 만든다.
//     (lib/worker.ts와 같은 경계. 400의 이유만 예외로 문장을 준다 — 고칠 사람이 읽어야 하니까)
//
// ⚠️ **Neon은 HTTP 드라이버로 부른다**(`@neondatabase/serverless`). 서버리스에서 보통
//  Postgres 커넥션 풀을 쓰면 인스턴스가 뜰 때마다 연결이 늘어 금세 한도를 넘긴다.
//  이 드라이버는 질의 하나가 HTTP 요청 하나라 **연결을 관리할 게 없다.**

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
// 남용 방어 ①. ⚠️ **약한 방어다** — Origin 헤더는 브라우저 밖에서 얼마든 위조된다.
//  막는 것은 "남의 사이트에 붙은 폼이 여기로 쏘는 것"까지고, 스크립트는 못 막는다.
//  4명 규모에 캡차·로그인 강제는 과하다는 판단(로드맵) → 신호등: 실제로 스팸이 들어올 때.
// ⚠️ 목록을 여기 두지 않는다 (2026-08-25). api/auth.ts도 같은 목록이 필요해졌는데, 보안
//  허용목록이 두 곳에 있으면 **한쪽만 고치는 날 조용히 갈라진다.** → 한 곳에서 읽는다.
import { ALLOWED_ORIGINS } from "../src/lib/oauth-config.js"; // ⚠️ .js가 맞다 — auth.ts 주석 참고

const KINDS = ["bug", "idea", "etc"];
const BODY_MAX = 1000;
const NICK_MAX = 40;
const PER_MINUTE = 5; // 같은 IP가 1분에 보낼 수 있는 건수


// meta는 **화이트리스트로만** 받는다. 클라이언트가 보낸 걸 그대로 jsonb에 부으면
// 언젠가 보내면 안 되는 것이 딸려 들어온다(⛔ 채널 목록·풀·시청 기록은 개수만 온다).
// 모르는 키는 조용히 버린다.
type MetaShape = { screen: string; signedIn: boolean; channels: number; viewport: string; ua: string; build: string };
const cut = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function cleanMeta(raw: unknown): Partial<MetaShape> {
  if (!raw || typeof raw !== "object") return {};
  const m = raw as Record<string, unknown>;
  const out: Partial<MetaShape> = {};
  if (m.screen !== undefined) out.screen = cut(m.screen, 40);
  if (m.signedIn !== undefined) out.signedIn = !!m.signedIn;
  if (Number.isFinite(Number(m.channels))) out.channels = Math.trunc(Number(m.channels));
  if (m.viewport !== undefined) out.viewport = cut(m.viewport, 20);
  if (m.ua !== undefined) out.ua = cut(m.ua, 300);
  if (m.build !== undefined) out.build = cut(m.build, 40);
  return out;
}

// 같은 사람인지 세기만 하면 되므로 되돌릴 수 없게 해시로. 소금이 없으면 IP 후보가
// 좁아(IPv4는 43억) 해시를 통째로 뒤집을 수 있다 → 소금은 사실상 필수다.
//
// ⚠️ **어느 헤더를 믿느냐가 곧 방어의 강도다.**
//  `x-forwarded-for`는 프록시들이 이어붙이는 목록이라 **맨 앞은 클라이언트가 쓴 값일 수 있다.**
//  그걸 그대로 세면 보내는 쪽이 헤더 한 줄만 돌려가며 바꿔도 분당 제한이 무력화된다.
//  → `x-real-ip`(플랫폼이 직접 넣는 실제 접속 IP)를 먼저 보고, 없으면 목록의 **맨 뒤**를 쓴다.
//    맨 뒤 = 우리와 제일 가까운 프록시가 붙인 값이라 위조가 안 닿는다.
//  ⚠️ 로컬 `vercel dev`는 둘 다 안 붙인다 → null → **제한을 건너뛴다**(로컬에선 정상).
function hashIp(req: VercelRequest): string | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[v.length - 1] : v) || "";
  const chain = one(req.headers["x-forwarded-for"]).split(",");
  const raw = (one(req.headers["x-real-ip"]) || chain[chain.length - 1] || "").trim();
  if (!raw) return null;
  return createHash("sha256").update(raw + "|" + (process.env.FEEDBACK_IP_SALT || "")).digest("hex");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 받는다" });
  }

  // 브라우저에서 온 요청인데 우리 주소가 아니면 거절. (Origin이 아예 없는 건 통과시킨다 —
  // curl·서버 간 호출이고, 여기서 막아봐야 위조 한 줄이면 그만이라 값이 없다)
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: "허용되지 않은 출처" });
  }

  // ⚠️ 설정 실수(환경변수 누락)는 사용자 잘못이 아니다 → 500. 그리고 **로그에 남긴다** —
  //  이 한 줄이 없으면 "왜 안 되지"를 배포된 곳에서 알아낼 방법이 없다.
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL이 없다 — Vercel 환경변수를 확인할 것");
    return res.status(500).json({ error: "서버 설정 문제" });
  }

  // Vercel이 JSON 본문을 미리 파싱해준다. 다만 문자열로 올 때(content-type 누락)도 대비한다.
  let payload: Record<string, unknown> = {};
  try {
    payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
  } catch {
    return res.status(400).json({ error: "JSON이 아니야" });
  }

  const kind = String(payload.kind ?? "");
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const nickname = typeof payload.nickname === "string" ? payload.nickname.trim() : "";

  if (!KINDS.includes(kind)) return res.status(400).json({ error: "유형이 이상해" });
  if (!body) return res.status(400).json({ error: "내용을 적어줘" });
  if (body.length > BODY_MAX) return res.status(400).json({ error: `${BODY_MAX}자를 넘었어` });
  if (nickname.length > NICK_MAX) return res.status(400).json({ error: "닉네임이 너무 길어" });

  const meta = cleanMeta(payload.meta);
  const ipHash = hashIp(req);
  const sql = neon(url);

  try {
    // 남용 방어 ③ — 분당 건수. ⚠️ IP를 못 읽으면(헤더 없음) 이 방어는 건너뛴다.
    if (ipHash) {
      const rows = (await sql`
        select count(*)::int as n from feedback
        where ip_hash = ${ipHash} and created_at > now() - interval '1 minute'
      `) as { n: number }[];
      if (rows[0]?.n >= PER_MINUTE) return res.status(429).json({ error: "너무 자주 보냈어" });
    }

    await sql`
      insert into feedback (kind, body, nickname, meta, ip_hash)
      values (${kind}, ${body}, ${nickname || null}, ${JSON.stringify(meta)}::jsonb, ${ipHash})
    `;
  } catch (e) {
    // ⚠️ 여기서 사용자에게 DB 오류 원문을 주면 안 된다(내부 구조가 새어나간다). 로그로만.
    console.error("feedback insert 실패:", e);
    return res.status(500).json({ error: "저장하지 못했어" });
  }

  // ⭐ **저장이 본체, 알림은 곁가지다.** 웹훅이 실패해도 201을 준다 —
  //  여기서 throw하면 이미 DB에 들어간 의견을 사용자가 "실패했다"고 믿고 다시 보낸다.
  await notify({ kind, body, nickname, meta }).catch(() => {});

  return res.status(201).json({ ok: true });
}

// 디스코드 웹훅 한 줄. 아무도 폴링하지 않으면 의견이 와도 모르기 때문에 넣는다.
// 없으면(환경변수 미설정) 조용히 건너뛴다 — 로컬 개발에서 웹훅까지 맞출 이유는 없다.
async function notify(f: { kind: string; body: string; nickname: string; meta: Partial<MetaShape> }) {
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) return;

  const label: Record<string, string> = { bug: "🐞 버그", idea: "💡 제안", etc: "💬 기타" };
  const who = f.nickname || "익명";
  const where = [f.meta.screen, f.meta.signedIn ? "로그인" : "비로그인", f.meta.viewport]
    .filter(Boolean)
    .join(" · ");

  await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // 디스코드 본문 상한은 2000자. body가 1000자 상한이라 여유가 있지만 잘라둔다.
    body: JSON.stringify({
      content: `**${label[f.kind] ?? f.kind}** · ${who}\n${f.body.slice(0, 1500)}\n-# ${where}`,
    }),
    // ⚠️ 타임아웃이 없으면 디스코드가 느릴 때 **사용자 응답까지 같이 늦어진다.**
    signal: AbortSignal.timeout(3000),
  });
}
