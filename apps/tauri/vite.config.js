import { defineConfig } from 'vite';
const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
  clearScreen: false,
  build: { rollupOptions: { input: { main: "index.html", anchor: "anchor.html" } } },
  server: {
    host: host || '127.0.0.1',
    port: 1420,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
