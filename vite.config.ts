import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 빌드 해시 — 의견 남기기가 "어느 버전에서 난 일인지"를 함께 보낸다.
// Vercel이 빌드할 때 VERCEL_GIT_COMMIT_SHA를 넣어준다. 로컬에서는 없으므로 "dev".
const BUILD = (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  server: {
    // ⚠️ 8765는 임의로 고른 값이 아니다 — Worker의 ALLOWED_ORIGINS와 구글 OAuth의
    //  "승인된 JavaScript 원본"에 이 주소가 등록돼 있다. Vite 기본값(5173)을 쓰면
    //  로컬에서 로그인도 채널 불러오기도 CORS에 막힌다.
    port: 8765,
    strictPort: true,
  },
});
