// types.ts — 계약이 정한 모양을 타입으로 옮긴 것.
//
// ⭐ 여기 있는 타입은 **새로 만든 규칙이 아니라 이미 있던 계약을 받아적은 것**이다.
//  `/rss` 응답, 저장되는 채널 한 줄, 백업 payload — 전부 docs/core의
//  10-flow-and-contracts.md에 글로 적혀 있던 것들이다. 이제 컴파일러가 같이 읽는다.

// 영상 한 편. `/rss`·`playlistItems` 양쪽이 같은 모양을 준다(계약이 그렇게 설계됐다).
export type Video = {
  id: string;
  title: string;
  link: string;
  date: string;
  published?: string;
  // 풀에는 여러 채널이 섞이므로 영상마다 채널명이 필요하다. 채널별 목록에선 안 쓴다.
  channel?: string;
  // 쇼츠인가 (2026-08-29). ⚠️ **없을 수 있다 — 그리고 «없음»은 «롱폼»이 아니라 «모른다»다.**
  //  Worker가 판정을 못 했거나(유튜브가 안 알려줌), 옛 Worker이거나, 캐시·풀에 옛 모양으로
  //  담겨 있는 경우다. `active`의 "필드 없음 = 켜짐"과 달리 **기본값을 두지 않는다** —
  //  모르는 것을 아는 척하면 롱폼 배지가 거짓말을 한다.
  short?: boolean;
};

// 풀에 담긴 영상 = 영상 + 언제 왜 담겼는지
export type PoolVideo = Video & { addedAt: number; source: string };

// 저장되는 채널 한 줄.
// ⚠️ `active`는 **없을 수 있다.** "필드 없음 = 켜짐" 규약(storage.isActive 참고).
export type Channel = {
  topic: string;
  name: string;
  channelId: string;
  active?: boolean;
};

// Worker가 알아낸 판정. 없으면 정상이다 — 이 "없음"이 계약의 핵심이라 optional로 둔다.
export type ChannelState = "gone" | "empty";

// `/rss` 200 응답. state가 있으면 videos는 비어 있고, gone이면 name도 null이다.
//
// ⭐ `verified`는 **판정을 얼마나 믿을 수 있는가**다 (2026-08-21). `gone`에만 붙는다.
//  Worker가 채널 페이지에 따로 확인해서 확정한 gone이면 true. 이 필드가 **없으면**
//  옛 Worker가 보낸 미확인 판정이므로 화면은 캐시된 영상을 지우지 않는다.
//  (Worker는 대시보드에 손으로 붙여넣어서 화면과 배포 시점이 어긋난다 — 그 틈을 메우는 필드다.)
export type ChannelFeed = {
  channelId: string;
  name: string | null;
  videos: Video[];
  state?: ChannelState;
  verified?: boolean;
};

// 화면이 실패를 읽는 방법. worker.ts와 youtube.ts가 **같은 모양으로** 붙여 넘긴다
// — 그래야 안내 코드가 출처를 몰라도 된다(10-flow "에러도 계약이다").
export type AppError = Error & {
  notFound?: boolean;
  needsAuth?: boolean;
  status?: number;
};

// 백업 payload = 드라이브에 올라가는 JSON 한 장. 키를 localStorage와 똑같이 쓴다.
export type ExportData = {
  myChannels: Channel[];
  watched: Record<string, number>;
  laterPool: Record<string, PoolVideo>;
  playlistId: string;
};

export type ExportPayload = {
  version: number;
  exportedAt: string;
  data: ExportData;
};
