# collect.py — 배포용: channel_id 상수 + RSS만 읽어 data.json 생성
# 실행: 터미널에서  python collect.py  →  같은 폴더에 data.json 생김
#
# 하는 일:
#  1) 채널마다 박아둔 channel_id(UC...)로 RSS를 연다  (핸들 긁기 없음)
#  2) 최신 영상 제목 + 링크 + 날짜를 뽑는다
#  3) "무엇을 보여줄지"만 담은 data.json으로 저장한다  (HTML을 하나도 모른다)
#
# 계약(interface): 화면이 어떻게 생겼는지 이 파일은 전혀 모른다.
#  data.json의 "모양"만 지키면, 화면(index.html + app.js)이 알아서 그린다.
#  → 파이썬을 Go로 바꾸든 서버를 붙이든, 이 모양만 지키면 화면은 한 줄도 안 바뀐다.
#
# 왜 핸들 긁기를 뺐나:
#  배포하면 수집 주체가 집 IP가 아니라 GitHub 데이터센터 IP다.
#  @핸들 페이지를 긁어 channel_id를 찾는 부분이 차단당하기 쉽다.
#  channel_id는 채널마다 절대 안 바뀌므로, 한 번 뽑아 상수로 박고 RSS만 읽는다.
#  RSS는 유튜브 공식 경로라 데이터센터에서도 안정적이다.

import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

# 한글 출력이 어디서든 안 깨지게 UTF-8 강제.
# (Windows 터미널 기본 cp949, GitHub Actions의 C 로케일에서 print가 터지는 것 방지)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# (주제, 이름, channel_id) — channel_id는 안 바뀌므로 상수로 박아둔다.
# 새 채널을 넣고 싶으면 로컬에서 id를 한 번 뽑아 이 리스트에 한 줄 추가하면 됨.
CHANNELS = [
    ("포챔스",     "모노",          "UCfKTcDDUzjMpPmV4KuOhkFg"),
    ("포챔스",     "즈랑",          "UCsBRzl28bxwukBr8bXYXbYA"),
    ("포챔스",     "눈파티",        "UCd6CX2LiQE2dEAPXwk2N0jg"),
    ("체스",       "체스인사이드",  "UCnUPEKHg9B8Ut75rsgqXWYw"),
    ("체스",       "체스프릭",      "UCO5rDIUWfCX7gsCzURXMUCg"),
    ("문명6",      "문명한입",      "UCc_tGAM6z-s-GCc6A6irdeg"),
    ("문명6",      "전구냥",        "UC3IJEZgLfSVgLdEXe8XbYag"),
    ("프로그래밍", "코드깎는노인",  "UCRpOIr-NJpK9S483ge20Pgw"),
    ("프로그래밍", "코딩애플",      "UCSLrpBAzr-ROVGHQ5EmxnUg"),
]

# 유튜브가 브라우저인 척 해야 잘 열림
HEADERS = {"User-Agent": "Mozilla/5.0"}
NS = {"a": "http://www.w3.org/2005/Atom"}


def latest_videos(channel_id, limit=3):
    """channel_id로 RSS를 열어 최신 영상 (제목, 링크, 날짜)을 뽑는다."""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers=HEADERS)
    xml = urllib.request.urlopen(req, timeout=20).read()

    root = ET.fromstring(xml)
    videos = []
    for entry in root.findall("a:entry", NS)[:limit]:
        title = entry.find("a:title", NS).text
        link = entry.find("a:link", NS).attrib["href"]
        published = entry.find("a:published", NS).text[:10]  # YYYY-MM-DD
        videos.append((title, link, published))
    return videos


def build_data(sections):
    """sections = [(주제, 이름, [(title, link, date), ...]), ...] → data.json용 dict.

    이 함수는 HTML 태그를 하나도 만들지 않는다. "무엇을 보여줄지"의 모양만 만든다.
    이 모양이 곧 화면과의 계약이다.  { updated, sections:[{topic,name,videos:[{title,link,date}]}] }
    """
    now = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d %H:%M")
    return {
        "updated": now,
        "sections": [
            {
                "topic": topic,
                "name": name,
                "videos": [
                    {"title": title, "link": link, "date": date}
                    for title, link, date in videos
                ],
            }
            for topic, name, videos in sections
        ],
    }


if __name__ == "__main__":
    # 채널을 하나씩 돌며 수집 → 한 채널이 실패해도 멈추지 않고 계속.
    sections = []
    for topic, name, cid in CHANNELS:
        try:
            videos = latest_videos(cid, limit=3)
        except Exception as e:
            videos = [(f"(수집 실패: {e})", "#", "")]
        sections.append((topic, name, videos))

    data = build_data(sections)
    # ensure_ascii=False: 한글을 \uXXXX로 깨지 않고 그대로 저장.
    # newline="\n": Mac/Windows 어디서 실행해도 결과 파일이 동일하게 나오게.
    with open("data.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print("data.json 생성 완료")
