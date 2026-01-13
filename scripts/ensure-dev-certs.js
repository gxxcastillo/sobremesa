#!/usr/bin/env node
// Generate self-signed certs for dev HTTPS if missing.
// Outputs to certs/sobremesa.local-cert.pem and certs/sobremesa.local-key.pem relative to repo root.

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const certDir = path.resolve(__dirname, '../certs');
const certPath = path.join(certDir, 'sobremesa.x-cert.pem');
const keyPath = path.join(certDir, 'sobremesa.x-key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  process.exit(0);
}

if (!fs.existsSync(certDir)) {
  fs.mkdirSync(certDir, { recursive: true });
}

const attrs = [{ name: 'commonName', value: 'sobremesa.x' }];
const altNames = [
  { type: 2, value: 'sobremesa.x' },
  { type: 2, value: 'localhost' },
];
const pems = selfsigned.generate(attrs, {
  days: 365,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    {
      name: 'subjectAltName',
      altNames,
    },
  ],
});

fs.writeFileSync(certPath, pems.cert, { encoding: 'utf8' });
fs.writeFileSync(keyPath, pems.private, { encoding: 'utf8' });

console.log(`[dev-certs] Generated dev TLS certs at ${certPath} and ${keyPath}`);
