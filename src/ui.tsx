// ui.tsx — 여러 화면이 같이 쓰는 모양 조각.
//
// 왜 클래스 문자열을 상수로 빼나: 버튼·입력칸이 네 화면에 흩어져 있는데 유틸리티를
// 각자 적으면 **한 곳만 고쳐서 어긋나는** 일이 생긴다. 옛 CSS에서 `#addForm button`,
// `.pool button`, `#backup button`이 **같은 선언을 세 번** 반복하던 것과 같은 문제라,
// 그때 셋이 늘 함께 바뀌었다는 사실을 여기서는 이름 하나로 못박는다.

import type { ReactNode } from "react";

export const btn =
  "px-3.5 py-2 rounded-lg border-0 bg-accent text-accent-ink font-semibold text-base " +
  "cursor-pointer disabled:opacity-50 disabled:cursor-default";

// 고스트 = 주된 행동이 아닌 것(다시 뽑기·전부 끄기·내려받기). 강조색을 안 쓴다.
export const btnGhost =
  "px-3.5 py-2 rounded-lg bg-transparent text-muted border border-line " +
  "cursor-pointer disabled:opacity-50 disabled:cursor-default";

export const btnGhostSm =
  "px-3 py-1.5 rounded-lg bg-transparent text-muted border border-line text-[.9rem] cursor-pointer";

export const input =
  "flex-1 min-w-0 px-2.5 py-2 border border-line rounded-lg text-base bg-transparent text-inherit";

// 상자 = 접히는 제어판(채널 추가·랜덤·드라이브)
export const boxed = "border border-line-faint rounded-[10px] px-3.5 py-2.5 mt-3.5 mb-[22px]";

// 링크는 크고 굵게 — 폰에서 누르기 쉬우라고 (옛 base 레이어의 a 규칙)
export const link = "text-[1.05rem] no-underline text-accent font-semibold hover:underline";

/** 진행·결과 문구. min-h로 자리를 미리 잡아 글자가 생길 때 화면이 안 튀게 한다. */
export function Status({ children }: { children?: ReactNode }) {
  return <span className="text-[.9rem] text-muted min-h-[1em]">{children}</span>;
}

/** 보조 안내. 본문보다 작고 흐리게. */
export function Hint({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[.8rem] text-muted mt-2 mb-0 ${className}`}>{children}</p>;
}

/** 채널 제목 — 왼쪽 색막대로 구분한다 (옛 h2 규칙) */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[1.05rem] font-bold mt-[26px] mb-2 pl-2 border-l-4 border-accent">
      {children}
    </h2>
  );
}
