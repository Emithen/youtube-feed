// drive.js — 내 앱 데이터를 **구글 드라이브의 앱 전용 숨은 폴더**(appDataFolder)에 둔다.
//
// 왜 이걸로 정했나 (2026-08-04, ROADMAP 국면 B):
//  이미 붙어 있는 OAuth에 스코프 한 줄만 더하면 되고, **새 벤더도 새 서버도 없다.**
//  결정적인 이유는 "일이 적어서"가 아니라 **재사용**이다 — storage.js의
//  exportAll()/replaceAll()이 이미 "JSON 한 장"을 주고받는 모양이라,
//  파일로 저장하던 것을 그대로 드라이브에 올리면 끝난다. `파일 ↔ 드라이브`만 바뀐다.
//
// appDataFolder가 뭔가:
//  앱마다 하나씩 주어지는 **사용자에게 안 보이는 폴더**. 내 드라이브 목록에 나타나지 않고
//  다른 앱도 못 본다. 대신 사람이 직접 열어 고칠 수도 없다.
//
// ⚠️ 2026-08-07에 파일로 내보내기/가져오기를 지웠다 → **여기가 유일한 사본이다.**
//    그 전까지는 백업 파일이 "구글 계정이 잠기면 쓸 출구" 역할을 했다.
//    되살릴 일이 생기면 git 이력에서 꺼낸다 (app.js의 wireBackup / downloadJSON).
//
// ⚠️ 토큰은 1시간짜리이고 refresh token이 없다(youtube.js 참고).
//    → **동기화는 로그인 세션에 종속된다.** 로그인 안 한 채로 쓰면 로컬만 바뀌고,
//      다음 로그인 때 올려야 한다. 자동 동기화를 아직 안 만든 이유이기도 하다.

// ⚠️ ?v= 는 app.js가 youtube.js를 부를 때와 **글자 그대로 같아야** 한다.
//    쿼리가 다르면 브라우저가 **다른 모듈로 취급해 두 번 로드**하고, 그러면 토큰을 쥔
//    변수가 둘이 되어 "로그인했는데 로그인이 필요해"가 뜬다. 버전 올릴 땐 항상 함께.
import { authedFetch } from "./youtube.js?v=23";

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// 파일 하나만 쓴다. 이름이 곧 식별자라서 바꾸면 이전 파일을 못 찾는다.
export const FILE_NAME = "youtube-feed-backup.json";

// Drive는 실패도 JSON으로 준다. 성공/실패 판정을 한 곳에 모은다.
async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

// ── 파일 찾기 ──
// 없으면 null. "아직 한 번도 안 올렸다"는 정상 상태라서 에러로 다루지 않는다.
export async function findFile() {
  const q = new URLSearchParams({
    spaces: "appDataFolder", // 이걸 빼면 사용자의 일반 드라이브를 뒤진다(권한도 없다)
    q: `name = '${FILE_NAME}' and trashed = false`,
    fields: "files(id,name,modifiedTime,size)",
    pageSize: "10",
  });
  const data = await json(await authedFetch(`${FILES}?${q}`));
  return data.files?.[0] || null;
}

// ── 내려받기 ──
// → { payload, modifiedTime } | null
export async function load() {
  const file = await findFile();
  if (!file) return null;
  // alt=media = 메타데이터가 아니라 **파일 내용**을 달라는 뜻. 그 내용이 곧 백업 JSON이다.
  const payload = await json(await authedFetch(`${FILES}/${file.id}?alt=media`));
  return { payload, modifiedTime: file.modifiedTime, size: Number(file.size) || 0 };
}

// ── 올리기 ──
// 만들기와 덮어쓰기를 **일부러 두 요청으로 나눴다.** 한 번에 하려면 multipart 본문을
// 손으로 조립해야 하는데, 그 복잡함을 "처음 한 번만 요청이 하나 더" 와 바꿨다.
export async function save(payload) {
  let file = await findFile();

  if (!file) {
    // 1) 빈 파일을 먼저 만든다. **부모(appDataFolder)를 정할 수 있는 건 여기뿐이다.**
    file = await json(
      await authedFetch(`${FILES}?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: FILE_NAME, parents: ["appDataFolder"] }),
      })
    );
  }

  // 2) 내용을 덮어쓴다. uploadType=media = 본문이 곧 파일 내용(메타데이터는 그대로 둔다).
  return json(
    await authedFetch(`${UPLOAD}/${file.id}?uploadType=media&fields=id,modifiedTime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}
