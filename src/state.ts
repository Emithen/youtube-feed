// state.ts — 화면이 공유하는 상태를 훅으로.
//
// 경계는 예전과 같다: **localStorage를 직접 부르는 곳은 lib/storage.ts 하나뿐**이다.
// 여기서는 그 값을 React 상태로 들고 있다가, 바뀌면 저장하고 다시 그린다.
//
// ⭐ 왜 상태를 App 한 곳에 모으나: 본 영상 기록이 **두 화면에 동시에 걸린다** —
//  피드에서 ✓를 누르면 랜덤 화면의 "안 본 것 N개"가 같이 바뀌어야 한다.
//  옛 코드는 이걸 `refreshPoolCount()`를 손으로 불러서 맞췄고, 부르는 걸 빠뜨리면
//  숫자가 조용히 낡았다. 상태를 위에 두면 그 호출 자체가 사라진다.

import { useCallback, useEffect, useState } from "react";
import * as store from "./lib/storage";
import * as yt from "./lib/youtube";
import type { Channel, PoolVideo } from "./lib/types";

// ────────────────────────── 해시 라우팅 ──────────────────────────
// 정적 사이트라 history.pushState로 /feed 같은 경로를 만들면 **새로고침 때 404**가 난다
// (그 경로에 파일이 없다). 해시는 서버 설정 없이 새로고침·뒤로가기가 그냥 된다.
// ⚠️ Vercel로 옮겨도 이 선택은 그대로 둔다 — rewrite 설정에 기대지 않는 편이 안전하고,
//    이미 공유된 #/feed 주소가 계속 열려야 한다.
export const SCREENS = ["feed", "channels", "random", "settings"] as const;
export type Screen = (typeof SCREENS)[number];

const readHash = (): Screen => {
  const name = location.hash.replace(/^#\/?/, "");
  // 모르는 해시나 빈 해시는 피드로. 예전에 공유한 "해시 없는 주소"도 그대로 열린다.
  return (SCREENS as readonly string[]).includes(name) ? (name as Screen) : "feed";
};

export function useHashRoute() {
  const [screen, setScreen] = useState<Screen>(readHash);
  useEffect(() => {
    const on = () => {
      setScreen(readHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return screen;
}

// ────────────────────────── 로그인 상태 ──────────────────────────
// youtube.ts가 모듈 로드 시점에 저장된 토큰을 되살린다. onAuthChange는 **바뀔 때만**
// 부르므로 첫 값은 isSignedIn()으로 직접 읽는다 (옛 wireAuth가 하던 것과 같다).
export function useAuth() {
  const [signedIn, setSignedIn] = useState(yt.isSignedIn);
  useEffect(() => {
    yt.onAuthChange(setSignedIn);
  }, []);
  return signedIn;
}

// ────────────────────────── 채널 목록 ──────────────────────────
export function useChannels() {
  const [channels, setChannels] = useState<Channel[]>(store.loadChannels);

  // 저장과 상태를 항상 같이 움직인다 — 한쪽만 바꾸면 새로고침 때 되돌아간다.
  const save = useCallback((list: Channel[]) => {
    store.saveChannels(list);
    setChannels(list);
  }, []);

  // 드라이브에서 통째로 덮어쓴 뒤처럼, 저장소가 밖에서 바뀌었을 때 다시 읽는다.
  const reload = useCallback(() => setChannels(store.loadChannels()), []);

  return { channels, save, reload };
}

// ────────────────────────── 본 영상 ──────────────────────────
export function useWatched() {
  const [watched, setWatched] = useState<Record<string, number>>(store.loadWatched);

  const has = useCallback((id: string) => store.hasWatched(watched, id), [watched]);

  // 영상을 클릭해 열면 자동으로 "봤음" 기록 (마찰 0)
  const mark = useCallback((id: string) => {
    if (store.markWatched(id)) setWatched(store.loadWatched());
  }, []);

  // 손으로 켜고 끄기 (실수로 클릭했을 때 되돌리기)
  const toggle = useCallback((id: string) => {
    store.toggleWatched(id);
    setWatched(store.loadWatched());
  }, []);

  const reload = useCallback(() => setWatched(store.loadWatched()), []);

  return { watched, has, mark, toggle, reload };
}

// ────────────────────────── 나중에 볼 풀 ──────────────────────────
export function usePool() {
  const [pool, setPool] = useState<Record<string, PoolVideo>>(store.loadPool);

  // 풀에 합치기. 이미 있는 건 그대로 두고(담은 시각 유지) 새 것만 넣는다.
  const merge = useCallback((videos: { id: string }[], source: string) => {
    const next = store.loadPool();
    let added = 0;
    for (const v of videos) {
      if (!v.id) continue;
      if (!next[v.id]) {
        next[v.id] = { ...(v as PoolVideo), addedAt: Date.now(), source };
        added++;
      }
    }
    store.savePool(next);
    setPool(next);
    return added;
  }, []);

  const clear = useCallback(() => {
    store.clearPool();
    setPool({});
  }, []);

  const reload = useCallback(() => setPool(store.loadPool()), []);

  return { pool, merge, clear, reload };
}
