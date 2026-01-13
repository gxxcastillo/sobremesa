/// <reference types='vitest' />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'path';
import fs from 'fs';
import selfsigned from 'selfsigned';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/publisher',
  server: {
    port: 3000,
    host: 'sobremesa.x',
    https: (() => {
      const certDir = path.resolve(import.meta.dirname, '../../certs');
      const certPath = path.join(certDir, 'sobremesa.x-cert.pem');
      const keyPath = path.join(certDir, 'sobremesa.x-key.pem');

      // Generate self-signed certs if they don't exist
      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

        const attrs = [{ name: 'commonName', value: 'sobremesa.x' }];
        const pems = selfsigned.generate(attrs, {
          days: 365,
          keySize: 2048,
          algorithm: 'sha256',
          extensions: [
            {
              name: 'subjectAltName',
              altNames: [
                { type: 2, value: 'sobremesa.x' },
                { type: 2, value: 'localhost' },
              ],
            },
          ],
        });

        fs.writeFileSync(certPath, pems.cert, { encoding: 'utf8' });
        fs.writeFileSync(keyPath, pems.private, { encoding: 'utf8' });
        console.log(`[vite] Generated dev TLS certs at ${certDir}`);
      }

      return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };
    })(),
    proxy: {
      '/api': {
        target: 'https://sobremesa.x:3001',
        changeOrigin: true,
        secure: false, // Allow self-signed certs
      },
    },
  },
  preview: {
    port: 4300,
    host: 'localhost',
  },
  plugins: [solid()],
  resolve: {
    alias: {
      '@sobremesa/api-client': path.resolve(import.meta.dirname, '../../libs/api-client/src/index.ts'),
    },
  },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  test: {
    name: 'publisher',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
