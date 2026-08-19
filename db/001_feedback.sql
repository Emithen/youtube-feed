-- 001_feedback.sql — 이 앱의 첫 테이블.
--
-- 왜 feedback이 첫 테이블인가 (ROADMAP "3-b" 절):
--  삽입 한 방향 · 행끼리 독립(충돌 없음) · 익명 허용 · 잘못돼도 의견 몇 건만 잃는다.
--  = 백엔드의 가장 싼 리허설. 내 데이터(myChannels·laterPool) 이사는 그 뒤다.
--
-- 실행법: Neon 콘솔 → 왼쪽 "SQL Editor" → 이 파일 내용을 붙여넣고 Run.
-- ⚠️ 마이그레이션 도구는 아직 안 쓴다. 파일 이름의 번호가 순서고, 실행은 손으로 한다.
--    (도구가 필요해지는 신호등: 테이블이 서넛으로 늘거나, 되돌릴 일이 생길 때)

create table if not exists feedback (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  kind        text        not null,   -- 'bug' | 'idea' | 'etc' (검사는 서버가 한다)
  body        text        not null,   -- 1~1000자
  nickname    text,                   -- 선택. "누가 썼는지 알려주고 싶을 때만"
  meta        jsonb       not null default '{}',  -- 화면·로그인 여부·채널 수·viewport·UA·빌드

  -- ⚠️ 로드맵 DDL에 없던 유일한 칸이다. 분당 건수 제한을 서버 메모리로는 할 수 없어서
  --    (서버리스는 요청마다 다른 인스턴스일 수 있다) DB에 세는 근거를 둔다.
  --    ⛔ **IP 원본은 저장하지 않는다** — sha256(IP + 소금)만. 되돌릴 수 없고,
  --       같은 사람인지 세는 데는 이걸로 충분하다.
  ip_hash     text
);

-- ⛔ user_id 컬럼을 지금 만들지 않는다. 멀티유저가 오면 ALTER로 붙인다 (필요한 것만 그때그때).

-- 읽는 쪽은 "최근 것부터" 하나뿐이다 (Neon 콘솔에서 SQL로 읽는다 — 앱 안 목록은 안 만든다).
create index if not exists feedback_recent_idx on feedback (created_at desc);

-- 분당 건수 제한이 매 요청마다 도는 질의라 이건 없으면 곧 느려진다.
create index if not exists feedback_ip_recent_idx on feedback (ip_hash, created_at desc);
