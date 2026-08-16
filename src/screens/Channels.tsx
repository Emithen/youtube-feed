// Channels.tsx — ① 채널 관리. **무엇을 볼지 고르는 곳.**
//
// 피드와 결정적으로 다른 점: **Worker를 한 번도 안 부른다.** 수백 개를 훑는 화면이라
// 영상을 같이 그리면 열자마자 채널 수만큼 요청이 나간다. 여기는 이름만 그린다.
// (채널을 추가할 때만 확인차 한 번 부른다 — 그건 사용자가 명시적으로 누른 것이다)

import { useState } from "react";
import * as store from "../lib/storage";
import * as worker from "../lib/worker";
import * as yt from "../lib/youtube";
import type { AppError, Channel } from "../lib/types";
import { Hint, Status, btn, btnGhostSm, input } from "../ui";

function ChannelRow({
  ch,
  onToggle,
  onDelete,
}: {
  ch: Channel;
  onToggle: (on: boolean) => void;
  onDelete: () => void;
}) {
  const on = store.isActive(ch);
  const title = on ? "피드에 나옴 — 눌러서 빼기" : "피드에서 빠짐 — 눌러서 넣기";

  return (
    <div className="flex items-center gap-2 py-[7px] border-b border-line-faint">
      {/* ⭐ 여기는 **수백 번 누르는 화면**이다(구독 319개를 고른다). 기호만 두면 히트영역이
          19×18이라 폰에서 못 누른다 → 패딩으로 손가락 크기까지 넓히고, 음수 마진으로
          되돌려 **줄 높이는 그대로** 둔다. 줄 높이가 곧 훑는 속도라서 키울 수 없다. */}
      <button
        type="button"
        onClick={() => onToggle(!on)}
        aria-pressed={on}
        aria-label={`${ch.name}: ${title}`}
        title={title}
        className={
          "flex-none text-[1.1rem] leading-none bg-transparent border-0 cursor-pointer " +
          "px-2.5 py-3 -mx-1.5 -my-3 " +
          (on ? "text-accent" : "text-muted opacity-60")
        }
      >
        {/* 색만으로 구분하지 않는다 — 기호(☑/☐)로도 읽히게 (본 영상 ✓/○ 와 같은 규칙) */}
        {on ? "☑" : "☐"}
      </button>

      <span className={"flex-1 min-w-0 [overflow-wrap:anywhere] " + (on ? "" : "opacity-45")}>
        {`[${ch.topic}] ${ch.name}`}
      </span>

      {/* ⭐ 삭제가 여기 있어야 하는 이유: 꺼진 채널은 피드에서 사라지므로,
          피드에 있던 삭제 버튼으로는 **영영 지울 수 없게 된다.** */}
      <button
        type="button"
        onClick={onDelete}
        className="flex-none px-2 py-px text-[.75rem] font-medium text-danger bg-transparent border border-danger-line rounded-md cursor-pointer"
      >
        삭제
      </button>
    </div>
  );
}

export default function Channels({
  channels,
  save,
  signedIn,
}: {
  channels: Channel[];
  save: (list: Channel[]) => void;
  signedIn: boolean;
}) {
  const [chInput, setChInput] = useState("");
  const [topic, setTopic] = useState("");
  const [name, setName] = useState("");
  const [addStatus, setAddStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const [subsStatus, setSubsStatus] = useState("");
  const [subsBusy, setSubsBusy] = useState(false);

  const activeCount = channels.filter(store.isActive).length;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const value = chInput.trim();
    if (!value) return;

    setAdding(true);
    setAddStatus("확인 중…");
    try {
      // Worker가 채널 해석 + 최신 영상까지 한 번에 준다 (요청 1회)
      const data = await worker.fetchChannel(value);

      // 죽은 채널은 추가해봐야 영원히 빈 칸이고, 이름조차 못 받는다(name: null).
      // ⚠️ 이건 throw가 아니라 **정상 응답**으로 온다 — catch에 걸리지 않으니 여기서 막는다.
      if (data.state === "gone") {
        setAddStatus("그 채널은 없어졌어 (삭제·정지된 것 같아).");
        return;
      }
      if (channels.some((c) => c.channelId === data.channelId)) {
        setAddStatus("이미 추가된 채널이야.");
        return;
      }

      const finalName = name.trim() || data.name || data.channelId;
      save([
        ...channels,
        { topic: topic.trim() || "내 채널", name: finalName, channelId: data.channelId },
      ]);

      // 방금 받은 영상을 바로 캐시에 넣어 두면 피드가 즉시 뜬다 (빈 것은 안 넣는다)
      if (!data.state) store.cacheChannel(data.channelId, data.videos);

      setChInput("");
      setTopic("");
      setName("");
      // ⭐ 영상 0개 채널은 이제 **추가된다.** 예전엔 502로 막혀서 "고장"처럼 보였는데,
      //  살아있는 채널이라 막을 이유가 없었다. 대신 피드가 빈 칸일 이유를 미리 말해준다.
      setAddStatus(
        data.state === "empty"
          ? `추가됨: ${finalName} — 아직 공개된 영상이 없어서 피드엔 빈 줄로 나와.`
          : `추가됨: ${finalName}`
      );
    } catch (err) {
      setAddStatus("실패: " + (err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  // 구독 채널 → 내 채널 목록에 **후보로** 담는다.
  // ⭐ `active: false`로 들어온다 — "구독한 것은 곧 볼 것"이라는 전제를 버렸기 때문이다.
  //    켜진 채로 들어오면 구독 수백 개가 그대로 피드가 되고, 피드를 열 때마다
  //    그만큼 Worker 요청이 나간다. 고르는 건 아래 목록에서.
  // 이미 있는 건 건드리지 않는다(주제·이름을 손봤을 수 있고, 이미 켜둔 것을 끄면 안 되니까).
  async function importSubscriptions() {
    setSubsBusy(true);
    setSubsStatus("구독 목록 읽는 중…");
    try {
      const subs = await yt.fetchSubscriptions((got, total) => {
        setSubsStatus(`구독 목록 읽는 중… ${got}${total ? "/" + total : ""}`);
      });
      const have = new Set(channels.map((c) => c.channelId));
      const next = [...channels];
      let added = 0;
      for (const s of subs) {
        if (have.has(s.channelId)) continue;
        next.push({ topic: "구독", name: s.name, channelId: s.channelId, active: false });
        have.add(s.channelId);
        added++;
      }
      save(next);
      // 빠진 이유를 셈해서 알려준다 (조용히 사라지면 왜 개수가 다른지 알 수 없다)
      // 꺼진 채로 들어온다는 것도 같이 말한다 — 안 그러면 피드가 그대로라 실패로 보인다.
      setSubsStatus(
        `구독 ${subs.length}개 중 ${added}개 담음` +
          (subs.length - added > 0 ? ` (이미 있던 것 ${subs.length - added}개)` : "") +
          (added > 0 ? " — 아래에서 볼 채널을 켜세요" : "")
      );
    } catch (e) {
      const err = e as AppError;
      setSubsStatus(err.needsAuth ? "로그인이 필요해." : "실패: " + err.message);
    } finally {
      setSubsBusy(false);
    }
  }

  return (
    <div>
      <details className="border border-line-faint rounded-[10px] px-3.5 py-2.5 mb-[22px]" open>
        <summary className="cursor-pointer font-semibold">＋ 내 채널 추가</summary>

        <div className="flex gap-2 flex-wrap items-center mt-2.5">
          {/* 로그인 버튼은 ④ 설정에 있다. 여기서 구독 버튼이 그냥 사라지면
              왜 없는지 알 수 없으므로, 로그아웃 상태에선 갈 곳을 알려준다. */}
          {signedIn ? (
            <>
              <button type="button" className={btn} disabled={subsBusy} onClick={importSubscriptions}>
                구독 채널 전부 가져오기
              </button>
              <Status>{subsStatus}</Status>
            </>
          ) : (
            <Hint className="!mt-0">
              구독 목록에서 가져오려면{" "}
              <a href="#/settings" className="text-accent font-semibold">
                ⚙️ 설정
              </a>
              에서 구글 로그인하세요.
            </Hint>
          )}
        </div>

        <form onSubmit={add} className="mt-2.5 flex flex-col gap-2">
          <input
            className={input}
            type="text"
            required
            value={chInput}
            onChange={(e) => setChInput(e.target.value)}
            placeholder="채널 링크 / @핸들 / 채널ID(UC…)"
          />
          <div className="flex gap-2">
            <input
              className={input}
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="주제(선택)"
            />
            <input
              className={input}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="이름(선택)"
            />
          </div>
          <button type="submit" className={btn} disabled={adding}>
            추가
          </button>
          <Status>{addStatus}</Status>
        </form>

        <Hint>이 브라우저에만 저장돼요(localStorage). 계정 없이 이 기기에서만 보입니다.</Hint>
      </details>

      {/* 켜진 개수를 세어 보여준다 — 수백 개일 때 "지금 몇 개가 피드에 나오나"가 안 보이면 못 고른다. */}
      <div className="flex items-baseline gap-2.5 mt-[22px] mb-2">
        <strong>내 채널</strong>
        <Status>{channels.length ? `${channels.length}개 중 ${activeCount}개 켜짐` : ""}</Status>
      </div>

      {/* 전부 켜기/끄기. 구독 319개를 손으로 끌 수는 없으니, 선별은 **전부 끄고 고르기**로 시작한다. */}
      <div className="flex gap-2 mb-3">
        <button
          type="button"
          className={btnGhostSm}
          onClick={() => save(channels.map((c) => ({ ...c, active: false })))}
        >
          전부 끄기
        </button>
        <button
          type="button"
          className={btnGhostSm}
          onClick={() => save(channels.map((c) => ({ ...c, active: true })))}
        >
          전부 켜기
        </button>
      </div>

      {channels.length === 0 ? (
        <Hint>아직 추가한 채널이 없어요. 위에서 채널 링크나 @핸들을 넣어 추가해보세요.</Hint>
      ) : (
        channels.map((ch) => (
          <ChannelRow
            key={ch.channelId}
            ch={ch}
            onToggle={(on) =>
              save(channels.map((c) => (c.channelId === ch.channelId ? { ...c, active: on } : c)))
            }
            onDelete={() => save(channels.filter((c) => c.channelId !== ch.channelId))}
          />
        ))
      )}
    </div>
  );
}
