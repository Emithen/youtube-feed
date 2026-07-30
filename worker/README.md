# worker — 내 RSS 릴레이 (Cloudflare Workers)

사용자가 추가한 채널의 최신 영상을 가져오는 **내 전용 프록시**.
공개 무료 프록시(레이트 리밋·다운으로 자주 실패)를 대체한다.

- 코드: `rss-proxy.js`
- 유형: L3(요청시 동적·무상태). DB·로그인 없음 → [아키텍처 나침반](../../service-architecture-types.md) 참고

## 계약(interface)

```
GET /rss?ch=<채널ID | @핸들 | 채널URL>&limit=6
→ { "channelId": "UC...", "name": "채널명",
    "videos": [ { "id": "...", "title": "...", "link": "...",
                  "date": "YYYY-MM-DD", "published": "ISO 시각" } ] }

GET /playlist?id=<재생목록ID 또는 재생목록URL>
→ { "playlistId": "PL...", "count": 87, "skipped": 2, "videos": [ 위와 같은 모양 ] }
```

`videos`의 모양이 두 엔드포인트에서 **동일**하므로 화면은 렌더 함수 하나로 처리한다.

### `/playlist` 주의사항

- 유튜브의 **"나중에 볼"(WL)은 읽을 수 없다.** 2016-09-12부터 API가 빈 목록을 주고 RSS는 404.
  → 사용자가 만든 **전용 재생목록**을 대신 쓴다.
- 재생목록은 **"일부 공개(unlisted)"** 이상이어야 한다. 완전 비공개는 OAuth가 필요해 지원 안 함.
- RSS(`playlist_id=`)는 최근 15개만 주므로, 전체를 얻으려고 Data API를 쓴다.
  50개씩 페이지네이션, 최대 20페이지(=1000개). Workers의 서브요청 한도(50)도 함께 지킨다.
- 비공개·삭제된 영상은 볼 수 없으므로 후보에서 빼고 `skipped`로 개수만 알려준다.

## 환경변수 (Secret)

| 이름 | 용도 | 없으면 |
|---|---|---|
| `YT_API_KEY` | YouTube Data API v3 키. `/playlist`에서만 사용 | `/playlist`가 500 + 안내 메시지 (`/rss`는 영향 없음) |

**등록 방법**: Worker → **Settings** → **Variables and Secrets** → Add →
타입 **Secret**, 이름 `YT_API_KEY`, 값에 발급받은 키 → Save.
Secret으로 넣으면 대시보드에서도 값이 다시 보이지 않고, **브라우저에는 절대 노출되지 않는다**
(브라우저는 내 Worker만 부르고, 키는 서버에서만 쓰인다).

키 발급: Google Cloud Console → 프로젝트 생성 → **YouTube Data API v3** 사용 설정 →
사용자 인증 정보 → API 키 만들기. (할당량 하루 10,000, `playlistItems.list`는 50개당 1로 넉넉)

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
