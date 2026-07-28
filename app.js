// app.js — data.json(수집기가 만든 데이터)을 읽어 화면을 그린다.
//
// 이 파일은 파이썬을 하나도 모른다. 오직 data.json의 "모양"(계약)만 안다:
//   { updated, sections: [ { topic, name, videos: [ { title, link, date } ] } ] }
// 수집기를 무엇으로 바꾸든, 이 모양만 지켜지면 이 파일은 한 줄도 안 바뀐다.

fetch("data.json")
  .then((res) => {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  })
  .then(render)
  .catch((err) => {
    document.getElementById("updated").textContent =
      "데이터를 불러오지 못했습니다: " + err;
  });

function render(data) {
  document.getElementById("updated").textContent =
    "업데이트: " + data.updated + " (KST)";

  const app = document.getElementById("app");
  app.replaceChildren(); // 혹시 남아 있던 내용 초기화

  for (const section of data.sections) {
    const h2 = document.createElement("h2");
    h2.textContent = `[${section.topic}] ${section.name}`;
    app.appendChild(h2);

    for (const video of section.videos) {
      const p = document.createElement("p");

      const a = document.createElement("a");
      a.href = video.link;
      a.target = "_blank";
      a.rel = "noopener";
      // textContent로 넣어 제목에 든 <, & 같은 문자를 안전하게 처리(XSS 방지).
      a.textContent = video.title;
      p.appendChild(a);

      if (video.date) {
        const small = document.createElement("small");
        small.textContent = " " + video.date;
        p.appendChild(small);
      }
      app.appendChild(p);
    }
  }
}
