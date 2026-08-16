import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // ⚠️ 8765는 임의로 고른 값이 아니다 — Worker의 ALLOWED_ORIGINS와 구글 OAuth의
    //  "승인된 JavaScript 원본"에 이 주소가 등록돼 있다. Vite 기본값(5173)을 쓰면
    //  로컬에서 로그인도 채널 불러오기도 CORS에 막힌다.
    port: 8765,
    strictPort: true,
  },
});
