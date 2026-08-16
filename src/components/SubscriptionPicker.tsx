// SubscriptionPicker.tsx — 구독 목록에서 채널을 골라 담는 모달.
//
// ⭐ **구독 목록은 화면의 한 섹션이 아니라 "채널 추가"라는 행동의 한 갈래다** (2026-08-17).
//  그전엔 구독 319개를 `myChannels`에 부어놓고 목록에서 켜고 껐다. 그 구조의 대가:
//   ⓐ 안 고른 286개가 드라이브 payload에 계속 실려 나갔다
//   ⓑ 유튜브에서 구독을 끊어도 앱엔 유령처럼 남았다
//   ⓒ `active`가 "후보 여부"와 "잠시 끄기" 두 뜻을 겸했다
//  → 구독은 **고를 때 잠깐 열어보는 것**으로 바꾸니 셋 다 사라진다.
//
// 나중에 개선안 4번(유튜브 검색)이 붙을 때 **같은 모양**이 된다 — "목록에서 골라 추가한다".
// 그때 이 컴포넌트를 재사용하거나, 최소한 이 UI 규칙을 그대로 따른다.
//
// `<dialog>`를 쓰는 이유: ESC 닫기·backdrop·포커스 트랩이 **브라우저 기본으로** 따라온다.
// 직접 만들면 그 셋이 전부 손일이고, 접근성은 대개 빠뜨린다.

import { useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import * as store from "../lib/storage";
import * as yt from "../lib/youtube";
import type { AppError, Channel } from "../lib/types";
import { Status, btn, btnGhost, input } from "../ui";

type Sub = { channelId: string; name: string };

export type PickerHandle = { open: () => void };

export default function SubscriptionPicker({
  ref,
  existing,
  onAdd,
}: {
  ref?: Ref<PickerHandle>;
  /** 이미 내 채널인 것 — 중복 추가를 막고 "이미 있음"을 보여준다 */
  existing: Set<string>;
  onAdd: (channels: Channel[]) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cached = store.loadSubs();
  const [subs, setSubs] = useState<Sub[]>(cached?.items ?? []);
  const [fetchedAt, setFetchedAt] = useState<number | null>(cached?.at ?? null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // ⭐ **열림/닫힘을 React 상태로 두지 않는다.** `<dialog>`가 이미 그 상태를 소유하고
  //  있는데(`el.open`), 그걸 `open` prop으로 복제했다가 실제로 어긋났다 (2026-08-17):
  //   ESC·backdrop처럼 **브라우저가 직접 닫는 경로**는 React를 안 거친다. 그러면 DOM은
  //   닫혔는데 상태는 열린 줄 알고, 버튼을 눌러도 `true → true`라 아무 일도 안 나서
  //   **모달이 영영 다시 안 열린다.**
  //  `close` 이벤트를 들어 되돌리는 방법도 있지만, 그건 "복제해두고 계속 맞추기"다.
  //  → **복제를 없앤다.** 여는 것만 명령으로 받고, 닫는 것은 DOM에 맡긴다.
  //    어긋날 두 값이 애초에 없으므로 동기화 버그가 생길 자리가 없다.
  useImperativeHandle(ref, () => ({
    open() {
      const el = dialogRef.current;
      if (!el || el.open) return;
      el.showModal(); // showModal이라야 backdrop·포커스 트랩·ESC가 붙는다
      // 캐시가 없을 때만 받아온다 — 열 때마다 구글을 부르면 "잠깐 열어본다"가 무거워진다
      if (subs.length === 0 && !busy) void load();
    },
  }));

  const close = () => dialogRef.current?.close();

  async function load() {
    setBusy(true);
    setStatus("구독 목록 읽는 중…");
    try {
      const got = await yt.fetchSubscriptions((n, total) => {
        setStatus(`구독 목록 읽는 중… ${n}${total ? "/" + total : ""}`);
      });
      setSubs(got);
      store.saveSubs(got); // 캐시일 뿐이다 — exportAll에 안 실린다
      setFetchedAt(Date.now());
      setStatus("");
    } catch (e) {
      const err = e as AppError;
      setStatus(err.needsAuth ? "로그인이 필요해 — ⚙️ 설정에서 로그인해줘." : "실패: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  // 훑기 대신 **찾기**. 319개를 순서로 이기려는 건 애초에 안 된다
  // (2026-08-17에 실제로 319개를 훑고 나서 나온 결론).
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return subs;
    return subs.filter((s) => s.name.toLowerCase().includes(needle));
  }, [subs, q]);

  const addable = shown.filter((s) => !existing.has(s.channelId));

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirm() {
    const chosen = subs.filter((s) => picked.has(s.channelId));
    // ⭐ 고른 순간 **내 채널**이 된다. `topic`을 "구독"으로 두지 않는 이유가 이것이다 —
    //  topic은 사용자가 붙이는 분류 라벨이지 "어디서 왔는지"를 적는 칸이 아니었다.
    //  그 둘을 겸하게 뒀던 것이 옛 구조의 혼선이었다.
    onAdd(chosen.map((s) => ({ topic: "내 채널", name: s.name, channelId: s.channelId })));
    setPicked(new Set());
    setQ("");
    close();
  }

  return (
    <dialog
      ref={dialogRef}
      // 모바일에선 바텀시트처럼 아래에 붙고, 데스크톱에선 가운데 뜬다
      className="m-0 w-full max-w-[640px] sm:m-auto rounded-t-2xl sm:rounded-2xl
                 fixed bottom-0 sm:static max-h-[85vh] p-0 bg-canvas text-canvas-ink
                 border border-line-faint backdrop:bg-black/50"
    >
      <div className="flex flex-col max-h-[85vh]">
        <div className="flex items-center gap-2 px-4 pt-4">
          <strong className="flex-1">📥 구독 목록에서 고르기</strong>
          <button
            type="button"
            onClick={close}
            aria-label="닫기"
            className="px-2 text-muted bg-transparent border-0 cursor-pointer text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <div className="px-4 pt-3">
          <input
            className={input + " w-full"}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="이름으로 좁히기"
          />
          <div className="flex items-baseline gap-2 mt-2">
            <Status>
              {status ||
                (subs.length
                  ? `${shown.length}개 표시 / 구독 ${subs.length}개`
                  : "아직 안 불러왔어")}
            </Status>
            {!busy && subs.length > 0 && (
              <button
                type="button"
                onClick={load}
                title={fetchedAt ? `${new Date(fetchedAt).toLocaleString()} 기준` : undefined}
                className="text-[.8rem] text-muted underline bg-transparent border-0 cursor-pointer"
              >
                새로 받기
              </button>
            )}
          </div>
        </div>

        {/* 목록만 스크롤한다 — 머리(검색)와 발(추가 버튼)은 고정이라 수백 개에서도 손이 안 멀다 */}
        <div className="flex-1 overflow-y-auto px-4 py-2 min-h-[30vh]">
          {shown.map((s) => {
            const have = existing.has(s.channelId);
            const on = picked.has(s.channelId);
            return (
              <label
                key={s.channelId}
                className={
                  "flex items-center gap-2 py-[7px] border-b border-line-faint " +
                  (have ? "opacity-45" : "cursor-pointer")
                }
              >
                <input
                  type="checkbox"
                  className="flex-none w-4 h-4 accent-[var(--color-accent)]"
                  checked={have || on}
                  disabled={have}
                  onChange={() => toggle(s.channelId)}
                />
                <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">{s.name}</span>
                {have && <span className="flex-none text-[.75rem] text-muted">이미 있음</span>}
              </label>
            );
          })}
          {!busy && subs.length > 0 && shown.length === 0 && (
            <p className="text-[.8rem] text-muted">"{q}"와 맞는 채널이 없어.</p>
          )}
          {!busy && subs.length === 0 && !status && (
            <p className="text-[.8rem] text-muted">구독 목록이 비어 있어.</p>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-line-faint">
          {/* ⚠️ 여기에 받아온 시각까지 넣었더니 폰(375px)에서 **세 줄로 깨졌다.**
              시각은 "새로 받기" 버튼의 title로 옮겼다 — 그 버튼을 누를지 정할 때만
              필요한 정보라 원래 거기 붙는 게 맞았다. */}
          <span className="flex-1 text-[.9rem] text-muted">
            {picked.size ? `선택 ${picked.size}개` : `고를 수 있는 것 ${addable.length}개`}
          </span>
          <button type="button" className={btnGhost} onClick={close}>
            취소
          </button>
          <button type="button" className={btn} disabled={picked.size === 0} onClick={confirm}>
            추가하기
          </button>
        </div>
      </div>
    </dialog>
  );
}
