// App.tsx — 화면 다섯을 잇는 곳. 상태를 여기 모아 아래로 내린다.
//  (2026-08-20에 넷 → 다섯. 다섯째가 「💬 의견」이다 — SCREENS 주석의 폭 경고 참고)
//
// ⭐ 옛 라우터는 네 화면을 **DOM에 전부 그려두고 hidden으로 숨겼다.** wire* 함수들이
//  getElementById로 요소를 잡았기 때문에, 안 보이는 화면도 DOM에 있어야만 동작했다
//  (`showImported()`가 다른 화면의 #plInput을 건드리는 식이었다).
//  React는 상태에서 화면을 만들므로 그 제약이 사라졌다 — 안 보는 화면은 아예 안 그린다.
//
// ⭐ 그런데 **피드만은 그리는 것 자체가 비싸다**(켜진 채널 수만큼 Worker 요청).
//  그래서 "안 그린다"에 더해 "이미 받아온 건 다시 안 받는다"가 필요하다 → epoch.
//  채널 목록이 바뀌면 epoch가 오르고, 그때만 피드가 다시 받아온다.
//  옛 `feedRendered = false` 를 손으로 내리던 자리가 전부 `bumpEpoch()`가 됐다.

import { useCallback, useRef, useState } from "react";
import Feed, { type Loaded } from "./screens/Feed";
import Channels from "./screens/Channels";
import Random from "./screens/Random";
import Settings from "./screens/Settings";
import Feedback from "./screens/Feedback";
import { SCREENS, useAuth, useChannels, useHashRoute, usePool, useWatched } from "./state";
import { isActive } from "./lib/storage";
import type { Channel } from "./lib/types";

const TAB_LABEL: Record<string, string> = {
  feed: "📺 피드",
  channels: "📋 채널",
  random: "🎲 랜덤",
  settings: "⚙️ 설정",
  feedback: "💬 의견",
};

export default function App() {
  const screen = useHashRoute();
  const signedIn = useAuth();
  const { channels, save, reload: reloadChannels } = useChannels();
  const watched = useWatched();
  const pool = usePool();

  // 피드가 낡았는지 세는 값. 채널이 바뀌면 오른다.
  const [epoch, setEpoch] = useState(0);

  // ⚠️ **"이미 받아왔다"는 표시는 state가 아니라 ref여야 한다.**
  //  state로 두면 StrictMode가 이펙트를 두 번 돌 때 첫 실행의 setState가 아직 반영되지
  //  않아 두 번째 실행이 그대로 통과한다 → **요청이 정확히 두 배로 나간다.**
  //  (dev에서만 두 번 돌지만, 그 사실에 기대는 코드는 안 만든다)
  //  ref는 즉시 바뀌므로 두 번째 실행이 확실히 막힌다.
  const loadedEpochRef = useRef(-1);
  const claimLoad = useCallback((e: number) => {
    if (loadedEpochRef.current === e) return false; // 이미 이 목록으로 받아왔다
    loadedEpochRef.current = e;
    return true;
  }, []);

  // ⭐ **실패한 로드는 "받아온 것"이 아니다** (2026-08-21).
  //  epoch는 "채널 목록이 바뀌었나"만 셌고 "그래서 성공했나"는 안 봤다. 그래서 40개가
  //  전부 실패해도 받아온 것으로 세고, 탭을 나갔다 와도 다시 안 받았다 — **화면이 실패한
  //  상태에 갇혔다.** 실패가 하나라도 있으면 표시를 도로 내려서 다음 방문에 다시 받는다.
  //  ref라 이걸 불러도 리렌더가 안 난다 → 지금 도는 이펙트를 다시 돌리지 않는다(루프 없음).
  const invalidateLoad = useCallback(() => {
    loadedEpochRef.current = -1; // epoch는 0부터 오르므로 -1과는 절대 안 겹친다
  }, []);

  // ── 손으로 누르는 "다시 불러오기" (2026-08-21) ──
  // 없으면 실패했을 때 사용자가 할 수 있는 일이 **기다리는 것뿐**이었다.
  // 잠금이 두 겹이라 둘 다 풀어야 실제로 다시 물어본다:
  //   ① epoch(claimLoad)  … 올려서 이펙트를 통과시킨다
  //   ② 브라우저 캐시      … fresh로 건너뛴다. 안 그러면 네트워크로 나가지도 않고
  //                          max-age 동안 방금 그 실패가 그대로 재생된다.
  const freshRef = useRef(false);
  const refreshFeed = useCallback(() => {
    freshRef.current = true;
    setEpoch((n) => n + 1);
  }, []);
  // 한 번 읽고 내린다 — 손으로 누른 그 한 번만 캐시를 건너뛴다.
  // (claimLoad 뒤에 부르므로 StrictMode의 두 번째 실행은 여기까지 오지 않는다)
  const takeFresh = useCallback(() => {
    const v = freshRef.current;
    freshRef.current = false;
    return v;
  }, []);
  // 받아온 피드 결과. **화면이 아니라 여기 둔다** — 탭을 옮겨도 안 사라져야
  // "이미 받아온 건 다시 안 받는다"가 성립한다 (Feed.tsx의 이펙트 주석 참고).
  const [feed, setFeed] = useState<Record<string, Loaded>>({});
  const onResult = useCallback(
    (channelId: string, result: Loaded) => setFeed((m) => ({ ...m, [channelId]: result })),
    []
  );

  // 선별이 바뀌면 피드는 낡았다 → 다음에 피드로 갈 때 다시 그린다.
  // 이게 없으면 켜고 끈 게 새로고침 전까지 반영되지 않아 **아무 일도 안 일어난 것처럼 보인다.**
  const saveChannels = useCallback(
    (list: Channel[]) => {
      save(list);
      setEpoch((n) => n + 1);
    },
    [save]
  );

  // 드라이브에서 통째로 덮어쓴 뒤 — 저장소가 밖에서 바뀌었으니 전부 다시 읽는다.
  const onReplaced = useCallback(() => {
    reloadChannels();
    watched.reload();
    pool.reload();
    setEpoch((n) => n + 1);
  }, [reloadChannels, watched, pool]);

  return (
    <>
      <h1>최신 영상 모음</h1>

      {/* 화면 탭. flex-1로 균등하게 — 폰에서 누르기 쉽게. */}
      <nav aria-label="화면" className="flex gap-0.5 mt-3.5 mb-[18px] border-b border-line-faint">
        {SCREENS.map((name) => (
          <a
            key={name}
            href={`#/${name}`}
            aria-current={screen === name ? "page" : undefined}
            className={
              "flex-1 px-1 py-2.5 text-center text-[.9rem] font-semibold no-underline " +
              "border-b-2 -mb-px " + // 밑줄이 컨테이너 선 위에 겹치게
              (screen === name ? "text-link border-accent" : "text-muted border-transparent")
            }
          >
            {TAB_LABEL[name]}
          </a>
        ))}
      </nav>

      {screen === "feed" && (
        <Feed
          channels={channels}
          epoch={epoch}
          loaded={feed}
          claimLoad={claimLoad}
          invalidateLoad={invalidateLoad}
          takeFresh={takeFresh}
          onRefresh={refreshFeed}
          onResult={onResult}
          hasWatched={watched.has}
          markWatched={watched.mark}
          toggleWatched={watched.toggle}
        />
      )}

      {screen === "channels" && (
        <Channels channels={channels} save={saveChannels} signedIn={signedIn} />
      )}

      {screen === "random" && (
        <Random
          pool={pool.pool}
          merge={pool.merge}
          clear={pool.clear}
          hasWatched={watched.has}
          markWatched={watched.mark}
          signedIn={signedIn}
        />
      )}

      {screen === "settings" && <Settings signedIn={signedIn} onReplaced={onReplaced} />}

      {/* 의견에 함께 실리는 건 **켠 채널 수**다 — 목록이 아니라 개수만 나간다(Feedback.tsx 주석). */}
      {screen === "feedback" && (
        <Feedback signedIn={signedIn} channels={channels.filter(isActive).length} />
      )}
    </>
  );
}
