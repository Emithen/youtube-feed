// Channels.tsx — ① 채널 관리. **무엇을 볼지 고르는 곳.**
//
// 피드와 결정적으로 다른 점: **Worker를 한 번도 안 부른다.** 수백 개를 훑는 화면이라
// 영상을 같이 그리면 열자마자 채널 수만큼 요청이 나간다. 여기는 이름만 그린다.
// (채널을 추가할 때만 확인차 한 번 부른다 — 그건 사용자가 명시적으로 누른 것이다)

import { useRef, useState } from "react";
import * as store from "../lib/storage";
import * as worker from "../lib/worker";
import type { Channel } from "../lib/types";
import { Hint, Status, btn, btnGhostSm, input } from "../ui";
import SubscriptionPicker, { type PickerHandle } from "../components/SubscriptionPicker";

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
  // ⭐ 열림 상태를 여기 두지 않는다 — `<dialog>`가 이미 갖고 있다(SubscriptionPicker 주석 참고).
  const picker = useRef<PickerHandle>(null);

  const activeCount = channels.filter(store.isActive).length;

  // ⚠️ 2026-08-17 이전 구조의 잔재 — 구독 319개를 `myChannels`에 부어놓고 켜고 끄던 시절의
  //  "안 고른 것"들이다. 지금은 구독을 저장하지 않으므로 이것들은 자리만 차지하고
  //  **드라이브 payload에 실려 다닌다.** 판별 기준이 `topic === "구독" && !active`인 이유:
  //  구독 가져오기가 그 모양으로 담았고, 앞으로 모달로 고른 것은 `topic: "내 채널"`이 된다.
  //  → 한 번 정리하면 이 배너는 다시 안 뜬다(조건이 스스로 사라진다).
  const leftover = channels.filter((c) => c.topic === "구독" && c.active === false);

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

  // ⭐ 구독 "가져오기"가 사라지고 "고르기"가 됐다 (2026-08-17).
  //  예전엔 319개를 통째로 `myChannels`에 부은 뒤 목록에서 켜고 껐다. 지금은 모달에서
  //  고른 것만 들어온다 — **담는 것과 고르는 것이 한 번에 끝난다.**
  function addPicked(picked: Channel[]) {
    const have = new Set(channels.map((c) => c.channelId));
    const fresh = picked.filter((c) => !have.has(c.channelId));
    if (fresh.length === 0) return;
    save([...channels, ...fresh]);
    setAddStatus(`${fresh.length}개 추가됨 — 아래 목록에서 켜고 끌 수 있어.`);
  }

  return (
    <div>
      <details className="border border-line-faint rounded-[10px] px-3.5 py-2.5 mb-[22px]" open>
        <summary className="cursor-pointer font-semibold">＋ 내 채널 추가</summary>

        {/* ⭐ 채널을 추가하는 갈래가 둘이고, **같은 자리에 형제로** 놓인다:
            ① 링크·@핸들 직접 입력 (아래 폼)   ② 구독 목록에서 고르기 (모달)
            개선안 4번(유튜브 검색)이 붙으면 여기 셋째로 들어온다 — 셋 다
            "목록/입력에서 골라 내 채널로 담는다"는 같은 모양이라 자리가 이미 있다. */}
        <div className="flex gap-2 flex-wrap items-center mt-2.5">
          {/* 로그인 버튼은 ④ 설정에 있다. 여기서 버튼이 그냥 사라지면
              왜 없는지 알 수 없으므로, 로그아웃 상태에선 갈 곳을 알려준다. */}
          {signedIn ? (
            <button type="button" className={btn} onClick={() => picker.current?.open()}>
              📥 구독 목록에서 고르기
            </button>
          ) : (
            <Hint className="!mt-0">
              구독 목록에서 고르려면{" "}
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

      {/* 옛 구조의 잔재 정리 — 한 번 누르면 조건이 사라져 다시 안 뜬다.
          ⚠️ 자동으로 지우지 않는다. 동기화가 대칭 덮어쓰기라 **드라이브까지 전파**되고
             되돌릴 수 없다 — 몇 개가 사라지는지 보여주고 확인을 받는 게 이 앱의 규칙이다. */}
      {leftover.length > 0 && (
        <div className="border border-line-faint rounded-[10px] px-3.5 py-2.5 mb-[22px]">
          <p className="m-0 text-[.9rem]">
            구독에서 가져왔지만 <strong>안 고른 채널 {leftover.length}개</strong>가 남아 있어요.
          </p>
          <Hint>
            이제 구독 목록은 <strong>필요할 때 불러오므로</strong> 저장해둘 필요가 없어요. 지우면
            드라이브에 올리는 양도 그만큼 줄어듭니다. 구독은 언제든 위 버튼으로 다시 볼 수 있어요.
          </Hint>
          <button
            type="button"
            className={btnGhostSm + " mt-2"}
            onClick={() => {
              if (
                !confirm(
                  `안 고른 구독 채널 ${leftover.length}개를 지웁니다.\n` +
                    `내 채널 ${channels.length - leftover.length}개는 그대로 남습니다.\n\n` +
                    "⚠️ 다음에 ☁️ 올리기를 누르면 드라이브에도 반영됩니다.\n\n계속할까요?"
                )
              )
                return;
              save(channels.filter((c) => !(c.topic === "구독" && c.active === false)));
              setAddStatus(`${leftover.length}개 정리했어.`);
            }}
          >
            {leftover.length}개 정리하기
          </button>
        </div>
      )}

      <SubscriptionPicker
        ref={picker}
        existing={new Set(channels.map((c) => c.channelId))}
        onAdd={addPicked}
      />

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
