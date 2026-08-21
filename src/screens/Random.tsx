// Random.tsx — ③ 랜덤 추천 (나중에 볼 풀)
//
// 유튜브의 "나중에 볼"(WL)은 API로 못 읽는다(2016년부터 차단). 그래서 전용 재생목록
// (watchme)을 동기화해 풀을 채우고, 그 안에서 무작위 1개를 제시한다.
// 이미 본 영상은 후보에서 뺀다(watched 재사용) → 뽑은 걸 열면 다음 후보에서 자동으로 빠진다.

import { useState } from "react";
import * as store from "../lib/storage";
import * as yt from "../lib/youtube";
import type { AppError, PoolVideo } from "../lib/types";
import { Status, btn, btnGhost, input } from "../ui";

// URL을 붙여넣으면 list= 값만 꺼낸다. 순수 ID면 그대로 쓴다.
function normalizePlaylistId(s: string) {
  const m = String(s).match(/[?&]list=([\w-]+)/);
  return (m ? m[1] : String(s)).trim();
}

export default function Random({
  pool,
  merge,
  clear,
  hasWatched,
  markWatched,
  signedIn,
}: {
  pool: Record<string, PoolVideo>;
  merge: (videos: { id: string }[], source: string) => number;
  clear: () => void;
  hasWatched: (id: string) => boolean;
  markWatched: (id: string) => void;
  signedIn: boolean;
}) {
  const [picked, setPicked] = useState<PoolVideo | null>(null);
  const [status, setStatus] = useState("");
  const [plInput, setPlInput] = useState(store.loadPlaylistId);
  const [syncing, setSyncing] = useState(false);

  const all = Object.keys(pool);
  const leftKeys = all.filter((k) => !hasWatched(k));

  function pick() {
    if (all.length === 0) {
      setStatus("풀이 비어 있어. 아래 '영상 채워넣기'로 먼저 담아줘.");
      setPicked(null);
      return;
    }
    if (leftKeys.length === 0) {
      setStatus("안 본 영상이 없어! 전부 봤네 🎉");
      setPicked(null);
      return;
    }
    setStatus("");
    setPicked(pool[leftKeys[Math.floor(Math.random() * leftKeys.length)]]);
  }

  // 풀을 채우려면 로그인이 필요하다. 눌러본 뒤 실패하게 두지 말고 먼저 알려준다.
  async function sync() {
    if (!signedIn) {
      setStatus("로그인이 필요해 — ⚙️ 설정에서 구글 로그인을 먼저 해줘.");
      return;
    }
    const id = normalizePlaylistId(plInput);
    if (!id) {
      setStatus("재생목록 ID나 URL을 넣어줘.");
      return;
    }

    setSyncing(true);
    setStatus("재생목록 읽는 중…");
    try {
      const data = await yt.fetchPlaylist(id);
      const added = merge(data.videos || [], "playlist");
      store.savePlaylistId(id); // 정리된 ID로 저장 → 다음에 열면 자동으로 채워둠
      setPlInput(id);
      setStatus(
        `동기화 완료: ${data.count}개 중 ${added}개 새로 추가` +
          (data.skipped ? ` (비공개·삭제 ${data.skipped}개 제외)` : "")
      );
    } catch (e) {
      // ID가 잘려서 실패하는 일이 잦다(URL에서 드래그로 복사하면 일부만 잡힘).
      // 그래서 실제로 쓴 ID와 길이를 같이 보여줘 스스로 알아채게 한다.
      // "못 찾음" 판정은 lib이 해준다(상태코드를 여기서 다시 뜯지 않는다).
      const err = e as AppError;
      const hint = err.notFound
        ? ` — 사용한 ID "${id}" (${id.length}자).` +
          " 재생목록 ID는 보통 18자나 34자야. 짧으면 복사하다 잘린 거니 URL을 통째로 붙여넣어줘." +
          " 길이가 맞다면 공개 범위를 '일부 공개'로 바꿔야 해(비공개는 읽을 수 없음)."
        : "";
      setStatus("실패: " + err.message + hint);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="border border-line-faint rounded-[10px] px-3.5 py-3 mb-[22px]">
      <div className="flex items-baseline gap-2.5 mb-2.5">
        <strong>🎲 랜덤 추천</strong>
        <Status>
          {all.length === 0 ? "비어 있음" : `안 본 것 ${leftKeys.length}개 / 전체 ${all.length}개`}
        </Status>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <button type="button" className={btn} onClick={pick}>
          랜덤으로 하나
        </button>
        {picked && (
          <button type="button" className={btnGhost} onClick={pick}>
            다시 뽑기
          </button>
        )}
      </div>

      {picked && (
        <div className="mt-3 mb-1 px-3.5 py-3 border-l-4 border-accent rounded-md bg-[color-mix(in_srgb,var(--color-accent)_9%,transparent)]">
          <a
            href={picked.link}
            target="_blank"
            rel="noopener"
            // 열어보면 본 것으로 기록 → 다음 뽑기 후보에서 자동으로 빠진다
            onClick={() => markWatched(picked.id)}
            className="text-[1.05rem] no-underline text-link font-semibold hover:underline"
          >
            {picked.title}
          </a>
          <small className="block mt-1 text-muted text-[.85rem]">
            {[picked.channel, picked.date].filter(Boolean).join(" · ")}
          </small>
        </div>
      )}

      <details className="mt-3.5">
        <summary className="cursor-pointer text-muted text-[.9rem]">영상 채워넣기 / 설정</summary>

        <label className="block mt-3 mb-[5px] text-[.85rem] text-muted">
          watchme 재생목록 (앞으로 담는 곳)
        </label>
        {/* 풀 비우기를 이 줄에 같이 두면 폰(375px)에서 입력칸이 눌린다 → 줄을 나눈다 */}
        <div className="flex gap-2 flex-wrap items-center">
          <input
            className={input}
            type="text"
            value={plInput}
            onChange={(e) => setPlInput(e.target.value)}
            placeholder="재생목록 ID 또는 URL (PL...)"
          />
          <button type="button" className={btn} disabled={syncing} onClick={sync}>
            동기화
          </button>
        </div>
        <Status>{status}</Status>
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              if (!confirm("풀을 비울까? (본 영상 기록은 남습니다)")) return;
              clear();
              setPicked(null);
              setStatus("풀을 비웠어.");
            }}
          >
            풀 비우기
          </button>
        </div>
      </details>
    </section>
  );
}
