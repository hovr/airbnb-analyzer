#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const current = String(manifest.version || '0.0.0');
const parts = current.split('.').map((part) => Number.parseInt(part, 10));

while (parts.length < 3) {
  parts.push(0);
}

if (parts.some((part) => Number.isNaN(part) || part < 0)) {
  throw new Error(`Unsupported manifest version: ${current}`);
}

parts[2] += 1;
manifest.version = parts.join('.');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Bumped extension version: ${current} -> ${manifest.version}`);
