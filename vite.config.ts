import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  clearScreen: false,
  // AudioWorklet modules must be real same-origin assets under Tauri's CSP.
  build: { target: 'es2022', assetsInlineLimit: 0 },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
});
