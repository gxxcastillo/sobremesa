import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: 'node_modules/.vite',
  server: {
    port: 3003,
    host: 'localhost',
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
  plugins: [solid()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
  },
}));
