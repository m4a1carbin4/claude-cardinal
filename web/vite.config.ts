import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발 중엔 카디널 서버(기본 7878)로 API/웹소켓을 넘김. 빌드 결과(dist)는 카디널 서버가 / 에서 서빙
const target = process.env.CARDINAL_URL ?? 'http://127.0.0.1:7878';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': target,
      '/ws': { target, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
