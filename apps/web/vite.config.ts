import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:3333', changeOrigin: true } },
  },
  build: {
    rollupOptions: {
      output: {
        // bibliotecas num arquivo próprio: mudam pouco e ficam no cache do navegador entre versões
        manualChunks(id: string) {
          if (/node_modules\/(react|react-dom|scheduler|react-router|@tanstack)\//.test(id)) return 'vendor';
        },
      },
    },
  },
  test: { environment: 'jsdom' },
} as never);
