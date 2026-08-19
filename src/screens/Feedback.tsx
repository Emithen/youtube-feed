// Feedback.tsx — ⑤ 의견 남기기. 백엔드(3번)의 첫 손님.
//
// 🚦 왜 생겼나: 지인 4명에게 테스트를 부탁했더니 **의견을 카톡으로 옮겨 전달하는 것**을
//  불편해했다. 쪼개보면 둘이다 —
//   보내는 쪽: 앱을 나가 다른 앱을 열고 무슨 화면이었는지 **말로 재구성**해야 한다 → 그래서 안 보낸다
//   받는 쪽: "어느 화면? 로그인은? 폰이야 노트북이야?"를 **되묻는 왕복**이 매번 붙는다
//  ⭐ 그래서 이 기능의 값은 입력창이 아니라 **상황을 자동으로 같이 보내는 것**에 있다.
//
// ⚠️ 그 자동 첨부가 이 화면의 유일한 위험이기도 하다. 그래서 두 가지를 지킨다:
//   ⓐ 무엇이 함께 가는지 **화면에 그대로 보여준다** (몰래 붙이면 그게 곧 사고다)
//   ⓑ ⛔ 채널 목록·풀·본 영상 기록은 **안 보낸다. 개수만.** 무엇을 보는지는 개인정보다
//
// ⭐ 읽는 쪽(목록·읽음 표시·답장)은 **일부러 안 만든다.** Neon 콘솔에서 SQL로 읽는다.
//  4명·하루 몇 건에는 SQL이 이긴다. 신호등: 같은 의견을 두 번 읽고 헷갈릴 때.

import { useEffect, useState } from "react";
import * as store from "../lib/storage";
import * as feedback from "../lib/feedback";
import type { FeedbackKind } from "../lib/feedback";
import type { AppError } from "../lib/types";
import { Hint, Status, btn, input } from "../ui";

const KIND_LABEL: Record<FeedbackKind, string> = {
  bug: "🐞 버그",
  idea: "💡 제안",
  etc: "💬 기타",
};

const BODY_MAX = 1000; // 서버와 같은 값. 넘으면 400이 오지만, 그 전에 화면이 막는다

// 실패를 사람 말로. **판정(status)은 서버가, 문장은 화면이** — worker.ts와 같은 경계다.
// ⭐ 400만 서버 문장을 그대로 쓴다. "1000자를 넘었어" 같은 건 고칠 사람이 읽어야 하는 말이라
//  서버가 쥐고 있는 게 맞고, 화면이 다시 쓰면 두 곳이 어긋난다.
function sayError(err: AppError): string {
  if (err.status === 400) return err.message;
  if (err.status === 429) return "너무 자주 보냈어 — 잠깐 뒤에 다시 눌러줘.";
  if (err.status === 0) return "네트워크가 안 돼 — 연결을 확인하고 다시 눌러줘.";
  return "보내지 못했어 — 잠시 뒤에 다시 눌러줘.";
}

export default function Feedback({ signedIn, channels }: { signedIn: boolean; channels: number }) {
  // ⭐ 초안을 저장소에서 되살린다. 이 화면은 탭을 옮기면 **언마운트된다**(App이 조건부로 그린다)
  //  → 쓰다가 피드를 잠깐 확인하고 오면 글이 사라진다. 그게 이 기능에서 낼 수 있는 최악의 사고다.
  const [draft] = useState(store.loadDraft);
  const [kind, setKind] = useState<FeedbackKind>((draft?.kind as FeedbackKind) || "bug");
  const [body, setBody] = useState(draft?.body || "");
  const [nickname, setNickname] = useState(draft?.nickname || "");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState(store.loadMyFeedback);

  // 입력이 바뀔 때마다 초안을 남긴다. **보낼 때가 아니라 쓸 때** 저장하는 게 핵심 —
  // 탭 이동·새로고침·실수로 닫기까지 전부 이걸로 살아남는다.
  useEffect(() => {
    if (body || nickname) store.saveDraft({ kind, body, nickname });
  }, [kind, body, nickname]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) {
      setStatus("내용을 적어줘.");
      return;
    }

    setBusy(true);
    setStatus("보내는 중…");
    try {
      await feedback.send(
        { kind, body: text, nickname: nickname.trim() },
        { screen: "#/feedback", signedIn, channels }
      );
      // 성공했을 때만 지운다. 그리고 **방금 보낸 것을 로컬에 남긴다** —
      // 자기가 뭘 보냈는지 확인할 길이 없으면 같은 말을 또 보내게 된다.
      setSent(store.addMyFeedback({ at: Date.now(), kind, body: text }));
      store.clearDraft();
      setBody("");
      setStatus("고마워, 잘 받았어.");
    } catch (e) {
      // ⚠️ **입력한 글은 지우지 않는다.** 초안도 그대로 남아 있다.
      setStatus(sayError(e as AppError));
    } finally {
      setBusy(false);
    }
  }

  const left = BODY_MAX - body.length;

  return (
    <form onSubmit={submit}>
      <div className="flex gap-2 flex-wrap">
        {(Object.keys(KIND_LABEL) as FeedbackKind[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={
              "px-3.5 py-2 rounded-lg text-base cursor-pointer border " +
              (kind === k
                ? "bg-accent text-accent-ink border-transparent font-semibold"
                : "bg-transparent text-muted border-line")
            }
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
        rows={6}
        placeholder="뭐가 불편했는지, 뭐가 있으면 좋겠는지 편하게 적어줘."
        aria-label="의견 내용"
        className="w-full mt-3 px-2.5 py-2 border border-line rounded-lg text-base bg-transparent text-inherit resize-y"
      />
      <div className="text-[.8rem] text-muted text-right -mt-1">
        {left < 100 ? `${left}자 남음` : `${body.length} / ${BODY_MAX}`}
      </div>

      <div className="flex gap-2 flex-wrap items-center mt-2.5">
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value.slice(0, 40))}
          placeholder="닉네임 (선택)"
          aria-label="닉네임 (선택)"
          className={input}
        />
        <button type="submit" className={btn} disabled={busy || !body.trim()}>
          보내기
        </button>
      </div>
      <Status>{status}</Status>

      {/* ⚠️ 자동 첨부를 숨기지 않는다. 여기 적힌 것이 실제로 가는 것 전부다. */}
      <Hint className="mt-3.5">
        함께 보내는 것: <strong>지금 화면 · 로그인 여부({signedIn ? "로그인됨" : "안 함"}) ·
        켠 채널 {channels}개 · 화면 크기 · 브라우저 종류 · 앱 버전</strong>. 되묻는 왕복을 줄이려고
        붙여요.
        <br />
        <strong>채널 목록 · 나중에 볼 풀 · 본 영상 기록은 보내지 않습니다</strong> (개수만).
        이메일도 받지 않아요.
      </Hint>

      {sent.length > 0 && (
        <details className="border border-line-faint rounded-[10px] px-3.5 py-2.5 mt-3.5 mb-[22px]">
          <summary className="cursor-pointer font-semibold">내가 보낸 것 {sent.length}개</summary>
          <ul className="list-none p-0 m-0 mt-2.5">
            {sent.map((f) => (
              <li key={f.at} className="py-1.5 border-b border-line-faint last:border-0">
                <div className="text-[.8rem] text-muted">
                  {KIND_LABEL[f.kind as FeedbackKind] ?? f.kind} ·{" "}
                  {new Date(f.at).toLocaleString()}
                </div>
                <div className="whitespace-pre-wrap break-words">{f.body}</div>
              </li>
            ))}
          </ul>
          {/* 이 목록은 **이 기기에만** 있다. 원본은 서버에 있고 여기 건 사본이라
              드라이브 동기화(exportAll)에도 안 실린다. */}
          <Hint>이 기기에서 보낸 것만 보여요.</Hint>
        </details>
      )}
    </form>
  );
}
