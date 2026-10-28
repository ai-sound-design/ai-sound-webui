import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The ai-services hybrid-api and spotting-api send no CORS headers,
// so the web UI reaches every service through this proxy:
//   /svc/hybrid/...     -> HYBRID_URL      (http://localhost:8004)
//   /svc/generation/... -> GENERATION_URL  (http://localhost:8000)
//   /svc/search/...     -> SEARCH_URL      (http://localhost:8002)
//   /svc/spotting/...   -> SPOTTING_URL    (http://localhost:8003)
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  const target = (name: string, fallback: string) => env[name] || fallback;
  const proxy = (prefix: string, url: string) => ({
    target: url,
    changeOrigin: true,
    // Hybrid jobs can take many minutes
    timeout: 0,
    proxyTimeout: 0,
    rewrite: (p: string) => p.slice(prefix.length) || '/',
  });
  const proxies = {
    '/svc/hybrid': proxy('/svc/hybrid', target('HYBRID_URL', 'http://localhost:8004')),
    // The generation gateway (8010) makes sounds of any length; the model itself answers on 8000
    '/svc/generation': proxy('/svc/generation', target('GENERATION_URL', 'http://localhost:8010')),
    '/svc/search': proxy('/svc/search', target('SEARCH_URL', 'http://localhost:8002')),
    '/svc/spotting': proxy('/svc/spotting', target('SPOTTING_URL', 'http://localhost:8003')),
    // The web UI's own server (server/): Pro Tools sessions and their media
    '/api': { target: target('SERVER_URL', 'http://localhost:8030'), changeOrigin: true, timeout: 0, proxyTimeout: 0 },
  };
  return {
    plugins: [react()],
    // ffmpeg.wasm starts its own worker and must not be pre-bundled
    optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
    server: { port: 5173, host: true, proxy: proxies },
    preview: { port: 4173, host: true, proxy: proxies },
  };
});
