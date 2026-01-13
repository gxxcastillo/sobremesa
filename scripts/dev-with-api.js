#!/usr/bin/env node
/**
 * Orchestrate dev: ensure certs, start API (3000, HTTPS), start Vite (4443, HTTPS).
 */
const path = require('path');
const { spawn } = require('child_process');

// Ensure certs
require('./ensure-dev-certs');

const ROOT = path.resolve(__dirname, '..');
const CERT_DIR = path.join(ROOT, 'certs');
const CERT = path.join(CERT_DIR, 'sobremesa.x-cert.pem');
const KEY = path.join(CERT_DIR, 'sobremesa.x-key.pem');

function assertFile(p) {
  if (!fs.existsSync(p)) {
    console.error(`[dev] Missing file: ${p}`);
    process.exit(1);
  }
}

assertFile(CERT);
assertFile(KEY);

const children = [];

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    ...opts,
  });
  children.push(child);
  child.on('exit', (code) => {
    console.error(`[dev] ${cmd} exited with code ${code}`);
    cleanup(code || 1);
  });
  child.on('error', (err) => {
    console.error(`[dev] ${cmd} error:`, err);
    cleanup(1);
  });
  return child;
}

function cleanup(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  console.log('\n[dev] Caught SIGINT, shutting down...');
  cleanup(0);
});
process.on('SIGTERM', () => {
  console.log('\n[dev] Caught SIGTERM, shutting down...');
  cleanup(0);
});

console.log('[dev] Starting API (https://sobremesa.x:3001) ...');
run('bun', ['run', 'src/main.ts'], {
  cwd: path.join(ROOT, 'apps/api'),
  env: {
    ...process.env,
    HOST: '0.0.0.0',
    PORT: '3001',
    TLS_CERT: CERT,
    TLS_KEY: KEY,
  },
});

console.log('[dev] Starting Web (https://sobremesa.x:3000) ...');
run('pnpm', ['vite', 'dev', '--host', '0.0.0.0', '--port', '3000'], {
  cwd: path.join(ROOT, 'apps/publisher'),
  env: {
    ...process.env,
    SSL_CERT_PATH: CERT,
    SSL_KEY_PATH: KEY,
  },
});

// Keep parent alive while children run
setInterval(() => {}, 1 << 30);
