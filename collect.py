# collect.py — 배포용: channel_id 상수 + RSS만 읽어 index.html 생성
# 실행: 터미널에서  python collect.py  →  같은 폴더에 index.html 생김
#
# 하는 일:
#  1) 채널마다 박아둔 channel_id(UC...)로 RSS를 연다  (핸들 긁기 없음)
#  2) 최신 영상 제목 + 링크 + 날짜를 뽑는다
#  3) 클릭 가능한 index.html 파일로 저장한다  (폰/브라우저로 열어봄)
#
# 왜 핸들 긁기를 뺐나:
#  배포하면 수집 주체가 집 IP가 아니라 GitHub 데이터센터 IP다.
#  @핸들 페이지를 긁어 channel_id를 찾는 부분이 차단당하기 쉽다.
#  channel_id는 채널마다 절대 안 바뀌므로, 한 번 뽑아 상수로 박고 RSS만 읽는다.
#  RSS는 유튜브 공식 경로라 데이터센터에서도 안정적이다.

import urllib.request
import xml.etree.ElementTree as ET

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


def build_html(sections):
    """sections = [(주제, 이름, [(title, link, date), ...]), ...] → HTML 문자열."""
    rows = []
    for topic, name, videos in sections:
        rows.append(f"<h2>[{topic}] {name}</h2>")
        for title, link, date in videos:
            rows.append(
                f'<p><a href="{link}" target="_blank" rel="noopener">{title}</a>'
                f' <small>{date}</small></p>'
            )

    body = "\n".join(rows)
    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>최신 영상 모음</title>
</head>
<body>
  <h1>최신 영상 모음</h1>
  {body}
</body>
</html>"""


if __name__ == "__main__":
    # 채널을 하나씩 돌며 수집 → 한 채널이 실패해도 멈추지 않고 계속.
    sections = []
    for topic, name, cid in CHANNELS:
        try:
            videos = latest_videos(cid, limit=3)
        except Exception as e:
            videos = [(f"(수집 실패: {e})", "#", "")]
        sections.append((topic, name, videos))

    html = build_html(sections)
    with open("index.html", "w", encoding="utf-8") as f:
        f.write(html)  # ← 이 파일을 GitHub Pages가 공개함
    print("index.html 생성 완료")
