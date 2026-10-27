import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발 중엔 카디널 서버(기본 7878)로 API/웹소켓을 넘김. 빌드 결과(dist)는 카디널 서버가 / 에서 서빙
const target = process.env.CARDINAL_URL ?? 'http://127.0.0.1:7878';
// localhost 말고 다른 이름(예: /etc/hosts 에 넣은 도메인)으로 들어올 때 허용할 호스트. 쉼표로 구분
const allowedHosts = (process.env.CARDINAL_WEB_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts,
    proxy: {
      '/api': target,
      '/ws': { target, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
