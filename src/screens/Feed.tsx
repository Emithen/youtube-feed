// Feed.tsx — ② 메인 피드. 켜둔 채널의 최신 영상을 그린다.
//
// ⭐ 이 화면이 **유일하게 비싼 화면**이다 — 켜진 채널 수만큼 Worker 요청이 나간다.
//  그래서 App이 `route === "feed"`일 때만 이걸 그리고, 한 번 받아온 결과는
//  채널 목록이 바뀌기 전까지 다시 안 받는다(epoch 비교). 옛 코드의 `feedRendered`와 같은 뜻인데,
//  깃발을 손으로 내리는 대신 **무엇이 바뀌면 낡는지**를 epoch가 이름으로 말해준다.

import { useEffect } from "react";
import * as store from "../lib/storage";
import * as worker from "../lib/worker";
import { isNew, videoKey } from "../lib/video";
import type { Channel, ChannelState, Video } from "../lib/types";
import { SectionTitle } from "../ui";

// ── Worker의 판정(state) → 화면에 띄울 한 줄 ──
// 문장을 여기서 만드는 이유: Worker는 "무슨 일이 있었나"만 알고, "뭐라고 말할까"는
// 화면마다 다르다(피드 vs 채널 추가 폼). lib/worker.ts 머리의 경계 규칙 그대로다.
const STATE_TEXT: Record<ChannelState, string> = {
  gone: "(채널이 없어졌어 — 삭제·정지된 것 같아)",
  empty: "(아직 공개된 영상이 없어)",
};

// 받아온 결과 한 칸. 영상이 있거나, 할 말(note)이 있거나 둘 중 하나다.
export type Loaded = { videos: Video[]; note?: string };

function VideoRow({
  v,
  seen,
  onOpen,
  onToggle,
}: {
  v: Video;
  seen: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  // 링크가 없는 자리표시자("불러오는 중"·실패·state 안내)에는 본 영상 표시를 안 붙인다
  const real = !!v.link && v.link !== "#";
  const badge = isNew(v) && !seen; // 이미 본 영상이면 NEW를 감춘다 — 본 것이 우선

  return (
    <p className="my-[7px]">
      {/* NEW 배지는 줄 맨 앞에 둬야 목록을 훑을 때 눈에 띈다 */}
      {badge && (
        <span className="inline-block mr-[7px] px-1.5 py-px rounded-[5px] bg-accent text-accent-ink text-[.68rem] font-bold tracking-[.04em] align-[2px]">
          NEW
        </span>
      )}
      <a
        href={v.link}
        target="_blank"
        rel="noopener"
        onClick={real ? onOpen : undefined}
        className={
          "text-[1.05rem] no-underline text-accent font-semibold hover:underline " +
          (seen ? "opacity-45 font-medium" : "")
        }
      >
        {/* 제목은 그냥 텍스트로 넣는다 — React가 이스케이프하므로 XSS 걱정이 없다
            (옛 코드가 innerHTML 대신 textContent를 쓴 것과 같은 보호) */}
        {v.title}
      </a>
      {v.date && <small className={"text-muted " + (seen ? "opacity-60" : "")}> {v.date}</small>}
      {real && (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={seen}
          title={seen ? "본 영상 — 눌러서 해제" : "안 본 영상 — 눌러서 봤음 표시"}
          aria-label={seen ? "본 영상 — 눌러서 해제" : "안 본 영상 — 눌러서 봤음 표시"}
          className={
            "ml-2 px-1 text-[.85rem] leading-none bg-transparent border-0 cursor-pointer " +
            (seen ? "text-accent opacity-90" : "text-muted opacity-55 hover:opacity-100")
          }
        >
          {/* 색만이 아니라 기호로도 구분한다 (채널 토글의 ☑/☐ 와 같은 규칙) */}
          {seen ? "✓" : "○"}
        </button>
      )}
    </p>
  );
}

export default function Feed({
  channels,
  epoch,
  loaded,
  claimLoad,
  onResult,
  onDelete,
  hasWatched,
  markWatched,
  toggleWatched,
}: {
  channels: Channel[];
  epoch: number;
  loaded: Record<string, Loaded>;
  /** 이 epoch를 내가 받아오겠다고 선점한다. 이미 선점됐으면 false. */
  claimLoad: (epoch: number) => boolean;
  onResult: (channelId: string, result: Loaded) => void;
  onDelete: (channelId: string) => void;
  hasWatched: (id: string) => boolean;
  markWatched: (id: string) => void;
  toggleWatched: (id: string) => void;
}) {
  const active = channels.filter(store.isActive);

  // ⚠️ **결과도 epoch도 App이 들고 있다.** 여기 두면 안 되는 이유가 둘이다:
  //  ① 탭을 옮기면 이 컴포넌트가 통째로 사라진다 → 돌아올 때마다 채널 수만큼 다시 요청.
  //     epoch로 아끼려던 것이 바로 그건데, 상태가 같이 사라지면 아낄 게 없다.
  //  ② StrictMode는 이펙트를 두 번 돌린다. 첫 실행이 "받아왔다"고 표시해두고 결과를
  //     버리면, 두 번째 실행은 건너뛰고 **영원히 "불러오는 중…"에 멈춘다.**
  //     그래서 진행 중인 요청을 취소하지 않는다 — 결과는 늦게 와도 그냥 App에 담긴다.
  //     대신 **중복 실행은 claimLoad(ref)가 동기적으로 막는다.**
  useEffect(() => {
    if (!claimLoad(epoch)) return; // 이 목록은 이미 누가 받아오고 있다 — 요청을 아낀다

    const cache = store.loadCache();

    for (const ch of active) {
      // 캐시가 있으면 즉시 보여주고, 뒤에서 조용히 갱신해 교체한다 → 체감 속도
      const cached = cache[ch.channelId];
      if (cached) onResult(ch.channelId, { videos: cached.videos });

      worker
        .fetchChannel(ch.channelId)
        .then((data) => {
          // 죽었거나 비었으면 그 사실을 한 줄로 알린다. **캐시에는 넣지 않는다** —
          // 채널이 되살아나거나 영상이 올라오면 다음 방문에 바로 반영돼야 하고,
          // 빈 배열을 캐시하면 그 자리가 "제목만 있는 빈 칸"으로 굳는다.
          if (data.state) {
            onResult(ch.channelId, { videos: [], note: STATE_TEXT[data.state] });
            return;
          }
          store.cacheChannel(ch.channelId, data.videos);
          onResult(ch.channelId, { videos: data.videos });
        })
        .catch((err: Error) => {
          // 캐시가 있으면 옛 것이라도 보여주는 편이 낫다 — 부분 실패 격리
          if (cached) return;
          onResult(ch.channelId, { videos: [], note: "(불러오기 실패: " + err.message + ")" });
        });
    }
    // active는 매 렌더 새 배열이라 의존성에 넣으면 무한 루프가 된다.
    // "언제 다시 받아야 하는가"는 epoch 하나가 이미 답한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  if (active.length === 0) {
    return (
      <p className="text-[.8rem] text-muted mt-2">
        아직 볼 채널이 없어요. <a href="#/channels" className="text-accent font-semibold">📋 채널</a>에서
        추가하거나 켜주세요.
      </p>
    );
  }

  return (
    <div>
      <p className="text-[.8rem] text-muted tracking-[.04em] mt-6 mb-0">— 내 채널 —</p>
      {active.map((ch) => {
        const result = loaded[ch.channelId];
        // 아직 아무것도 못 받았으면 자리표시자. 링크가 "#"이라 ✓/○가 안 붙는다.
        const rows: Video[] = result
          ? result.note
            ? [{ id: "", title: result.note, link: "#", date: "" }]
            : result.videos
          : [{ id: "", title: "불러오는 중…", link: "#", date: "" }];

        return (
          <div key={ch.channelId}>
            <SectionTitle>
              {`[${ch.topic}] ${ch.name}`}
              <button
                type="button"
                onClick={() => onDelete(ch.channelId)}
                className="ml-2.5 px-2 py-px align-middle text-[.75rem] font-medium text-danger bg-transparent border border-danger-line rounded-md cursor-pointer"
              >
                삭제
              </button>
            </SectionTitle>
            {rows.map((v, i) => {
              const key = videoKey(v);
              return (
                <VideoRow
                  key={key || i}
                  v={v}
                  seen={!!key && hasWatched(key)}
                  onOpen={() => markWatched(key)}
                  onToggle={() => toggleWatched(key)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
