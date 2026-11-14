import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // 개발 서버는 이 맥에서만. 외부 접속은 백엔드(Tailscale 주소)가 빌드된 페이지를 서비스
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8010' }, // 개발 중에도 같은 경로(/api)로 호출
  },
})
