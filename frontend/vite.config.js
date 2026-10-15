import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the browser talks to Vite (5173) and /api is proxied to the backend (5000).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:5000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
