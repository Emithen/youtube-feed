// Settings.tsx — ④ 설정. 로그인·데이터 관리.
//
// ⭐ **두 드라이브 버튼은 방향만 다른 같은 동작이다**(2026-08-15에 대칭으로 바꿨다):
//     올리기   … 내 기기 → 드라이브를 **덮어쓴다**
//     내려받기 … 드라이브 → 내 기기를 **덮어쓴다**
//   누른 쪽이 통째로 이긴다. 규칙이 한 줄이라 "지금 뭐가 어떻게 될까"를 안 헷갈린다.
//
// 왜 합치기를 그만뒀나: 올리기가 "내려받아 합친 뒤 올린다"였을 때는 **아무것도 지울 수 없었다.**
//   내가 지운 채널이 클라우드에서 다시 딸려와 되살아났고, 그게 그대로 저장돼 클라우드에서도
//   영영 안 없어졌다. 데이터가 줄지 않는 건 안전했지만 **선별이 이 앱의 중심이 된 뒤로는
//   "줄이는 것"이 곧 기능**이라, 줄일 수 없는 동기화는 쓸모가 없었다.
//
// ⚠️ 대가: 누르는 쪽이 반대편을 지운다. 그래서 **양쪽 다 확인창**을 거치고,
//   무엇이 몇 개 사라지는지 숫자로 보여준 뒤에만 진행한다.
// ⚠️ 시각 기록이 없어 **마지막에 누른 쪽이 이긴다.** 어느 쪽이 더 새 것인지는 앱이 모른다.

import { useState } from "react";
import * as store from "../lib/storage";
import * as yt from "../lib/youtube";
import * as drive from "../lib/drive";
import type { AppError } from "../lib/types";
import { Hint, Status, btn, btnGhost } from "../ui";

// ── 동기화 결과를 사람 말로 ──
// 무엇을 담고 어떻게 덮어쓸지는 storage가 안다. 여기서는 **세어서 보여주는 것**만 한다.
type Data = Record<string, unknown>;

function countsOf(data: Data) {
  const n = store.countOf;
  return `채널 ${n(data[store.KEYS.channels])} · 본 영상 ${n(data[store.KEYS.watched])} · 풀 ${n(
    data[store.KEYS.pool]
  )}`;
}

// 덮어쓰면 무엇이 얼마나 달라지는지. **줄어드는 쪽에만** 부호를 붙인다 —
// 지워지는 것이 이 확인창의 유일한 목적이라, 늘어나는 숫자가 눈을 끌면 안 된다.
function countsChange(before: Data, after: Data) {
  const n = store.countOf;
  const line = (label: string, key: string) => {
    const a = n(before[key]);
    const b = n(after[key]);
    return `${label} ${a} → ${b}` + (b < a ? `   (${b - a}개 사라짐)` : "");
  };
  return [
    line("채널", store.KEYS.channels),
    line("본 영상", store.KEYS.watched),
    line("나중에 볼 풀", store.KEYS.pool),
  ].join("\n");
}

export default function Settings({
  signedIn,
  onReplaced,
}: {
  signedIn: boolean;
  /** 드라이브에서 통째로 덮어쓴 뒤 — 화면이 저장소를 다시 읽어야 한다 */
  onReplaced: () => void;
}) {
  const [authStatus, setAuthStatus] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [driveStatus, setDriveStatus] = useState("");
  const [driveBusy, setDriveBusy] = useState(false);

  // ⭐ 로그인·로그아웃 둘 다 **결과를 받아서 말해준다** (2026-08-25). 그전엔 로그아웃이
  //  무조건 "로그아웃했어."였는데, 이제는 서버 세션까지 끊어야 해서 **반쪽만 되는 경우가
  //  생긴다.** 반쪽을 성공이라고 말하면 사람은 끝난 줄 안다.
  async function toggleAuth() {
    setAuthBusy(true);
    setAuthStatus(signedIn ? "로그아웃하는 중…" : "구글 창을 여는 중…");
    try {
      const r = signedIn ? await yt.signOut() : await yt.signIn();
      if (r.ok) {
        setAuthStatus(signedIn ? "로그아웃했어." : "");
      } else if (signedIn) {
        // 브라우저에서는 이미 빠져나왔다 — 그 사실을 먼저 말하고, 남은 것을 말한다.
        setAuthStatus("이 기기에서는 로그아웃했어. 다만 " + r.message);
      } else {
        setAuthStatus(r.message);
      }
    } catch (e) {
      setAuthStatus("실패: " + (e as Error).message);
    } finally {
      setAuthBusy(false);
    }
  }

  // 두 버튼이 실패 처리·버튼 잠금이 같아서 한 겹으로 감쌌다.
  async function run(label: string, fn: () => Promise<string>) {
    setDriveBusy(true);
    setDriveStatus(label);
    try {
      setDriveStatus(await fn());
    } catch (e) {
      const err = e as AppError;
      setDriveStatus(
        err.needsAuth ? "로그인이 필요해 — 위에서 다시 로그인해줘" : "실패: " + err.message
      );
    } finally {
      setDriveBusy(false);
    }
  }

  const upload = () =>
    run("드라이브를 확인하는 중…", async () => {
      const payload = store.exportAll();
      // 읽는 이유는 합치려는 게 아니라 **지금 드라이브에 뭐가 있는지 세어 보여주려는 것**이다.
      // 드라이브가 비어 있으면(첫 올리기) 사라질 게 없으니 확인창도 없다.
      const remote = await drive.load();
      if (remote) {
        const when = new Date(remote.modifiedTime).toLocaleString();
        if (
          !confirm(
            "이 기기 내용으로 드라이브를 덮어씁니다.\n" +
              "드라이브에만 있는 것은 사라집니다.\n\n" +
              countsChange((remote.payload?.data as Data) || {}, payload.data as Data) +
              `\n\n드라이브 저장 시각: ${when}\n\n계속할까요?`
          )
        ) {
          return "취소했어 — 아무것도 안 바뀌었어.";
        }
      }
      await drive.save(payload);
      return `올렸어 — ${countsOf(payload.data as Data)}`;
    });

  const download = () =>
    run("드라이브에서 읽는 중…", async () => {
      const remote = await drive.load();
      if (!remote) return "드라이브에 아직 없어. 먼저 ☁️ 올리기를 눌러줘.";

      // ⚠️ 내려받기는 **합치기가 아니라 교체**다(2026-08-15부터) — 이 기기에만 있던 것이
      //    사라진다. 되돌릴 수 없으므로 **줄어드는 숫자를 눈으로 보여주고** 확인을 받는다.
      //    숫자를 안 보여주면 "받았어"만 뜨고 316개가 조용히 사라질 수 있다.
      const when = new Date(remote.modifiedTime).toLocaleString();
      const before = store.exportAll().data as Data;
      const after = (remote.payload?.data as Data) || {};
      if (
        !confirm(
          "드라이브 내용으로 이 기기를 덮어씁니다.\n" +
            "이 기기에만 있는 것은 사라집니다.\n\n" +
            countsChange(before, after) +
            `\n\n드라이브 저장 시각: ${when}\n\n계속할까요?`
        )
      ) {
        return "취소했어 — 아무것도 안 바뀌었어.";
      }

      store.replaceAll(remote.payload);
      onReplaced(); // 받아온 것이 화면에 바로 보이게 (안 그러면 새로고침해야 알 수 있다)
      return `받았어 — ${countsOf(after)} (드라이브 저장 시각: ${when})`;
    });

  return (
    <div>
      {/* 구글 로그인: 내 유튜브 구독·재생목록을 직접 읽기 위한 인가(youtube.readonly).
          ⛔ "나중에 볼"(WL)은 로그인해도 못 읽는다(2016년부터 차단) → watchme 우회는 그대로. */}
      <div className="flex gap-2 flex-wrap items-center">
        <button type="button" className={btn} disabled={authBusy} onClick={toggleAuth}>
          {signedIn ? "로그아웃" : "구글 로그인"}
        </button>
        <Status>{signedIn && !authStatus ? "로그인됨 — 내 구독·재생목록을 직접 읽어요" : authStatus}</Status>
      </div>

      <details className="border border-line-faint rounded-[10px] px-3.5 py-2.5 mt-3.5 mb-[22px]">
        <summary className="cursor-pointer font-semibold">☁️ 드라이브 동기화</summary>

        {/* 동기화는 로그인 세션에 종속된다(토큰 1시간, refresh 없음) → 상태를 버튼에 그대로 비춘다. */}
        <div className="flex gap-2 flex-wrap items-center mt-2.5">
          <button type="button" className={btn} disabled={!signedIn || driveBusy} onClick={upload}>
            올리기
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={!signedIn || driveBusy}
            onClick={download}
          >
            내려받기
          </button>
        </div>
        <Status>{!signedIn ? "구글 로그인을 하면 켜져요." : driveStatus}</Status>

        <Hint>
          채널 · 본 영상 · 나중에 볼 풀 · 재생목록 ID를 앱 전용 숨은 폴더에 저장해요 (내 드라이브
          목록엔 안 보이고, 다른 앱도 못 봅니다. 채널 캐시는 다시 만들어지므로 제외).{" "}
          <strong>누른 쪽이 통째로 이깁니다.</strong> 올리기는 드라이브를 이 기기 내용으로,
          내려받기는 이 기기를 드라이브 내용으로 덮어써요. 채널을 켜고 끈 것·지운 것까지 그대로
          따라옵니다.
          <br />
          대신 <strong>반대편에만 있던 것은 사라집니다.</strong> 그래서 누르기 전에 몇 개가
          사라지는지 보여드려요.
        </Hint>
      </details>
    </div>
  );
}
