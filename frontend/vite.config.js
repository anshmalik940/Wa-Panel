import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development the browser talks to Vite (5173) and /api is proxied to the backend (5000).
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiUrl = env.VITE_API_URL?.trim();

  if (command === 'build' && mode === 'production') {
    if (!apiUrl) {
      throw new Error('VITE_API_URL is required for production builds. Set it to the Render backend origin (for example, https://your-service.onrender.com).');
    }
    let parsedApiUrl;
    try {
      parsedApiUrl = new URL(apiUrl);
    } catch {
      throw new Error('VITE_API_URL must be a valid HTTPS backend origin without an /api path.');
    }
    if (parsedApiUrl.protocol !== 'https:' || !['', '/'].includes(parsedApiUrl.pathname) || parsedApiUrl.search || parsedApiUrl.hash) {
      throw new Error('VITE_API_URL must be an HTTPS backend origin without a path, query, or fragment.');
    }
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': { target: env.VITE_PROXY_TARGET || 'http://localhost:5000', changeOrigin: true } },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});
