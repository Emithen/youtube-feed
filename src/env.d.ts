/// <reference types="vite/client" />

// 빌드 시점에 vite.config.ts가 박아 넣는 커밋 해시. 의견에 함께 실려 온다
// ("어느 버전에서 난 일인지"를 모르면 고친 뒤에도 같은 제보가 계속 온다).
declare const __BUILD__: string;
