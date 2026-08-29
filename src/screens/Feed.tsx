// Feed.tsx — ② 메인 피드. 켜둔 채널의 최신 영상을 그린다.
//
// ⭐ 이 화면이 **유일하게 비싼 화면**이다 — 켜진 채널 수만큼 Worker 요청이 나간다.
//  그래서 App이 `route === "feed"`일 때만 그리고, 받아온 결과는 채널 목록이 바뀌기 전까지
//  다시 안 받는다. **무엇이 바뀌면 낡는지**를 `epoch`가 이름으로 말해준다.

import { useEffect, useState } from "react";
import * as store from "../lib/storage";
import * as worker from "../lib/worker";
import { exactTime, isNew, relativeTime, videoKey } from "../lib/video";
import type { Channel, ChannelState, Video } from "../lib/types";
import { SectionTitle, btnGhostSm } from "../ui";

// ── Worker의 판정(state) → 화면에 띄울 한 줄 ──
// 문장을 여기서 만드는 이유: Worker는 "무슨 일이 있었나"만 알고, "뭐라고 말할까"는
// 화면마다 다르다(피드 vs 채널 추가 폼). lib/worker.ts 머리의 경계 규칙 그대로다.
const STATE_TEXT: Record<ChannelState, string> = {
  gone: "(채널이 없어졌어 — 삭제·정지된 걸 확인했어)",
  empty: "(아직 공개된 영상이 없어)",
};

// ⭐ **확인되지 않은 판정에는 확인되지 않았다고 쓴다.** `verified` 없는 `gone`은 사실인지
//  알 수 없다 → **모르는 것을 아는 척하지 않는다**: 문장도 단정하지 않고, 영상도 안 지운다.
const UNVERIFIED_GONE = "(채널이 없어졌을 수도 있어 — 확인이 안 됐어)";

// 못 받아왔지만 지난번 것이 남아 있을 때. **낡았다는 사실을 말하고** 보여준다 —
// 조용히 옛 데이터를 내놓으면 사용자는 그게 최신인 줄 안다.
const STALE = "(지금은 못 불러왔어 — 아래는 지난번에 받아둔 것)";

// 받아온 결과 한 칸. ⚠️ note와 videos는 **배타가 아니다** — "낡은 목록을 보여주면서
// 낡았다고 말하기"가 필요하다.
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

  // ⭐ 안내 줄은 **영상처럼 보이면 안 된다.** 같은 목록에 함께 나오므로 생김새가 같으면
  //  안내가 여섯 번째 영상처럼 읽힌다 — 누를 수 없는 것을 누를 수 있게 그리지 않는다.
  if (!real) {
    return <p className="my-[7px] text-[.9rem] text-muted">{v.title}</p>;
  }

  return (
    <p className="my-[7px]">
      {/* NEW 배지는 줄 맨 앞에 둬야 목록을 훑을 때 눈에 띈다 */}
      {badge && (
        /* 바탕이 accent 가 아니라 **link** 다 — .68rem 굵은 글자에 3.29:1 은 미달이었다 */
        <span className="inline-block mr-[7px] px-1.5 py-px rounded-[5px] bg-link text-on-link text-[.68rem] font-bold tracking-[.04em] align-[2px]">
          NEW
        </span>
      )}
      {/* ⭐ 쇼츠에만 붙이고 **롱폼엔 아무것도 안 붙인다.** 「롱폼」 배지를 만들면 배지 없는
          줄의 뜻이 둘로 갈린다 — 롱폼이거나, 판정을 못 했거나.
          ⚠️ 그래서 `=== true`로 본다. `undefined`는 «모른다»이지 «아니오»가 아니다.
          생김새는 NEW와 일부러 다르게: NEW는 채워진 강조색(새 소식), 이건 테두리만 둔
          흐린 칩(분류표). 같은 모양이면 나란히 붙었을 때 하나로 읽힌다. */}
      {v.short === true && (
        <span className="inline-block mr-[7px] px-1.5 py-px rounded-[5px] border border-line text-muted text-[.68rem] font-bold tracking-[.04em] align-[2px]">
          쇼츠
        </span>
      )}
      <a
        href={v.link}
        target="_blank"
        rel="noopener"
        onClick={onOpen}
        // ⭐ **본 영상은 흐리게 하지 않는다** (2026-08-22). opacity-45 는 글자를
        //  배경 쪽으로 끌어내려 대비를 깬다 — 다크에서는 거의 안 보였다. 대신 색을
        //  한 단 낮춘다(link → muted): 「덜 중요하다」는 읽히면서 대비는 지켜진다.
        //  ⚠️ 흐림을 쓸 자리는 **정보가 없는 쪽**이다(썸네일이 붙으면 거기에 건다).
        // ⚠️ font-semibold 를 공통 자리에 두면 안 된다 — seen 쪽 font-medium 과 **둘 다 붙어**
        //  CSS 파일 순서로 semibold 가 이긴다(실측 w=600). 굵기는 갈래마다 하나씩만 적는다.
        className={
          "text-[1.05rem] no-underline hover:underline " +
          (seen ? "text-ink-muted font-medium" : "text-link font-semibold")
        }
      >
        {/* 제목은 그냥 텍스트로 넣는다 — React가 이스케이프하므로 XSS 걱정이 없다 */}
        {v.title}
      </a>
      {/* ⚠️ 날짜와 토글은 **함께 움직여야 한다.** 히트영역을 키운 뒤 ✓ 가 혼자
          다음 줄로 떨어지는 걸 확인했다 — 제목만 줄바꿈하고 이 덩어리는 안 쪼개진다. */}
      <span className="whitespace-nowrap">
        {v.date && (
          // 상대 시각은 원래 값을 지우므로 정확한 시각을 title 로 함께 단다.
          <small className="text-muted" title={exactTime(v)}>
            {" "}
            {relativeTime(v)}
          </small>
        )}
        <button
        type="button"
        onClick={onToggle}
        aria-pressed={seen}
        title={seen ? "본 영상 — 눌러서 해제" : "안 본 영상 — 눌러서 봤음 표시"}
        aria-label={seen ? "본 영상 — 눌러서 해제" : "안 본 영상 — 눌러서 봤음 표시"}
        // ⚠️ 기호만 두면 히트영역이 20px 안팎이라 폰에서 옆 링크가 먼저 잡힌다.
        //  ⭐ 패딩으로 넓히는 것만으로는 32×38 이었다(실측). 크기를 **명시**한다.
        className={
          "inline-flex items-center justify-center w-11 h-11 align-middle " +
          // 히트영역은 44×44 로 두고 **차지하는 자리만** 음수 마진으로 줄인다
          // (44 → 세로 20px · 가로 24px). 채널 목록의 ☑/☐ 가 쓰는 수법과 같다.
          "-my-3 -mr-3 -ml-1 " +
          "text-[.85rem] leading-none bg-transparent border-0 cursor-pointer " +
          (seen ? "text-link" : "text-muted opacity-70 hover:opacity-100")
        }
        >
          {/* 색만이 아니라 기호로도 구분한다 (채널 토글의 ☑/☐ 와 같은 규칙) */}
          {seen ? "✓" : "○"}
        </button>
      </span>
    </p>
  );
}

export default function Feed({
  channels,
  epoch,
  loaded,
  claimLoad,
  invalidateLoad,
  takeFresh,
  onRefresh,
  onResult,
  hasWatched,
  markWatched,
  toggleWatched,
}: {
  channels: Channel[];
  epoch: number;
  loaded: Record<string, Loaded>;
  /** 이 epoch를 내가 받아오겠다고 선점한다. 이미 선점됐으면 false. */
  claimLoad: (epoch: number) => boolean;
  /** 선점을 도로 내린다 — 실패한 로드는 "받아온 것"이 아니다. */
  invalidateLoad: () => void;
  /** 이번 로드가 손으로 누른 것인가(=브라우저 캐시를 건너뛸 것인가). 한 번만 true. */
  takeFresh: () => boolean;
  onRefresh: () => void;
  onResult: (channelId: string, result: Loaded) => void;
  hasWatched: (id: string) => boolean;
  markWatched: (id: string) => void;
  toggleWatched: (id: string) => void;
}) {
  const active = channels.filter(store.isActive);

  // 받아오는 중인가. **"다시 불러오기"에 반응이 없으면 사용자는 눌린 줄도 모른다.**
  // 결과 칸은 캐시 때문에 안 비어 있을 수 있어서, 진행 표시가 따로 필요하다.
  const [busy, setBusy] = useState(false);

  // ⚠️ **결과도 epoch도 App이 들고 있다.** 여기 두면 안 되는 이유가 둘이다:
  //  ① 탭을 옮기면 이 컴포넌트가 통째로 사라진다 → 돌아올 때마다 채널 수만큼 다시 요청.
  //     epoch로 아끼려던 것이 바로 그건데, 상태가 같이 사라지면 아낄 게 없다.
  //  ② StrictMode는 이펙트를 두 번 돌린다. 첫 실행이 "받아왔다"고 표시해두고 결과를
  //     버리면, 두 번째 실행은 건너뛰고 **영원히 "불러오는 중…"에 멈춘다.**
  //     그래서 진행 중인 요청을 취소하지 않는다 — 결과는 늦게 와도 그냥 App에 담긴다.
  //     대신 **중복 실행은 claimLoad(ref)가 동기적으로 막는다.**
  useEffect(() => {
    if (active.length === 0) return; // 받아올 게 없다
    if (!claimLoad(epoch)) return; // 이 목록은 이미 누가 받아오고 있다 — 요청을 아낀다

    const fresh = takeFresh(); // claimLoad 뒤에 부른다 — 두 번째 실행이 삼키면 안 된다
    const cache = store.loadCache();
    let pending = active.length;
    setBusy(true);
    const done = () => {
      if (--pending === 0) setBusy(false);
    };

    for (const ch of active) {
      // 캐시가 있으면 즉시 보여주고, 뒤에서 조용히 갱신해 교체한다 → 체감 속도
      const cached = cache[ch.channelId];
      if (cached) onResult(ch.channelId, { videos: cached.videos });

      worker
        .fetchChannel(ch.channelId, fresh)
        .then((data) => {
          // ⭐ **확인되지 않은 판정으로 데이터를 지우지 않는다.** 네트워크 실패(catch)는
          //  캐시를 지키는데 오진이 캐시를 덮어쓰면 그게 더 파괴적이다 — 덧붙이기만 한다.
          if (data.state === "gone" && !data.verified) {
            onResult(ch.channelId, { videos: cached?.videos ?? [], note: UNVERIFIED_GONE });
            invalidateLoad(); // 확정이 아니다 → 다음 방문에 다시 물어본다
            return;
          }
          // 확인된 gone·empty는 그 사실을 한 줄로 알린다. **캐시에는 넣지 않는다** —
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
          invalidateLoad(); // 실패는 "받아온 것"이 아니다 — 다음 방문에 다시 받는다
          // 캐시가 있으면 옛 것이라도 보여주는 편이 낫다(부분 실패 격리).
          // 다만 **낡았다는 사실은 말한다** — 조용히 내놓으면 최신인 줄 안다.
          onResult(ch.channelId, {
            videos: cached?.videos ?? [],
            note: cached ? STALE : "(불러오기 실패: " + err.message + ")",
          });
        })
        .finally(done);
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
      <div className="flex items-center gap-2.5 mt-6">
        <p className="text-[.8rem] text-muted tracking-[.04em] m-0">— 내 채널 —</p>
        {/* 실패했을 때 사용자가 할 수 있는 일이 이 버튼 하나다 — 탭 이동(claimLoad)도
            새로고침(브라우저 캐시)도 다시 받아오지 못한다. 이게 그 두 잠금을 함께 푼다. */}
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className={btnGhostSm + " disabled:opacity-50 disabled:cursor-default"}
        >
          {busy ? "불러오는 중…" : "↻ 다시 불러오기"}
        </button>
      </div>
      {active.map((ch) => {
        const result = loaded[ch.channelId];
        // 아직 아무것도 못 받았으면 자리표시자. 링크가 "#"이라 ✓/○가 안 붙는다.
        // ⚠️ note와 videos를 **함께** 그린다 — 안내는 맨 윗줄에 얹히고 영상은 그 아래 남는다.
        //  note가 영상을 갈아치우면 오진 하나로 멀쩡한 목록이 사라진다.
        const rows: Video[] = result
          ? [
              ...(result.note ? [{ id: "", title: result.note, link: "#", date: "" }] : []),
              ...result.videos,
            ]
          : [{ id: "", title: "불러오는 중…", link: "#", date: "" }];

        return (
          <div key={ch.channelId}>
            {/* ⭐ **삭제 버튼을 뺐다** (2026-08-22). 훑는 화면에 되돌릴 수 없는 행동이
                섞여 있었고, 지운 결과는 동기화가 대칭 덮어쓰기라 다음 「☁️ 올리기」에
                **드라이브까지 전파**된다. 2026-08-15에 목록 쪽에 삭제를 붙이면서
                (꺼진 채널은 피드에서 사라지므로) 이쪽의 역할은 이미 끝나 있었다. */}
            <SectionTitle>{`[${ch.topic}] ${ch.name}`}</SectionTitle>
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
