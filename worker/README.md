# worker — 내 RSS 릴레이 (Cloudflare Workers)

사용자가 추가한 채널의 최신 영상을 가져오는 **내 전용 프록시**.
공개 무료 프록시(레이트 리밋·다운으로 자주 실패)를 대체한다.

- 코드: `rss-proxy.js`
- 유형: L3(요청시 동적·무상태). DB·로그인 없음 → [아키텍처 나침반](../../service-architecture-types.md) 참고

## 계약(interface)

```
GET /rss?ch=<채널ID | @핸들 | 채널URL>&limit=3
→ { "channelId": "UC...", "name": "채널명",
    "videos": [ { "title": "...", "link": "...", "date": "YYYY-MM-DD" } ] }
```

`data.json`의 sections 한 칸과 **같은 모양**이라, 프론트는 추천/내 채널을 똑같이 다룬다.

## 배포 방법 (대시보드, 5분 · CLI 불필요)

1. https://dash.cloudflare.com 가입 (무료, 카드 불필요)
2. 좌측 **Workers & Pages** → **Create** → **Workers** → **Create Worker**
3. 이름을 정하고(예: `yt-rss`) **Deploy** (기본 hello-world가 먼저 올라감)
4. **Edit code** → 편집기 내용을 전부 지우고 `rss-proxy.js` 내용을 붙여넣기 → **Deploy**
5. 주소 확인: `https://<이름>.<계정서브도메인>.workers.dev`
6. 동작 확인: 브라우저에서 `https://<주소>/rss?ch=@mkbhd` 열어 JSON이 나오면 성공

> 코드를 고치면 4번(붙여넣기 → Deploy)만 반복하면 된다.

## 접근 제한

`ALLOWED_ORIGINS`에 있는 사이트에서만 쓰도록 CORS를 제한한다.
(내 Worker가 남의 무료 프록시로 쓰이는 걸 막으려고.)
사이트 주소가 바뀌면 이 배열을 고치고 다시 Deploy.

## 무료 한도

하루 10만 요청 / 요청당 CPU 10ms. 이 서비스 규모로는 한참 남는다.
같은 채널 반복 요청은 Cloudflare 엣지 캐시가 대신 답한다(영상 10분, 핸들→ID 1시간).
