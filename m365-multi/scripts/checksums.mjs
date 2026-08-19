#!/usr/bin/env node
// Write or verify SHA-256 checksums for everything shipped in vendor/.
//
// The vendored bundle is a build artefact nobody can review by reading it, so
// the checksums let anyone rebuild with `npm run build:vendor` and confirm they
// get the same bytes — and let a customer confirm the files they received match
// the ones published.
//
//   node scripts/checksums.mjs write
//   node scripts/checksums.mjs verify

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, 'vendor');
const sumsFile = join(vendorDir, 'SHA256SUMS');

const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === sumsFile) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const entries = walk(vendorDir)
  .map((p) => [relative(vendorDir, p).split(sep).join('/'), digest(p)])
  .sort((a, b) => a[0].localeCompare(b[0]));

const mode = process.argv[2];

if (mode === 'write') {
  const body = entries.map(([f, h]) => `${h}  ${f}`).join('\n') + '\n';
  writeFileSync(sumsFile, body);
  console.log(`wrote ${entries.length} checksums to vendor/SHA256SUMS`);
} else if (mode === 'verify') {
  const expected = new Map(
    readFileSync(sumsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [h, ...rest] = line.split(/\s+/);
        return [rest.join(' '), h];
      })
  );
  let bad = 0;
  for (const [f, h] of entries) {
    const want = expected.get(f);
    if (!want) {
      console.error(`UNEXPECTED  ${f}`);
      bad++;
    } else if (want !== h) {
      console.error(`MISMATCH    ${f}`);
      bad++;
    }
    expected.delete(f);
  }
  for (const f of expected.keys()) {
    console.error(`MISSING     ${f}`);
    bad++;
  }
  if (bad) {
    console.error(`\n${bad} problem(s). Do not ship or install this build.`);
    process.exit(1);
  }
  console.log(`all ${entries.length} vendored files match SHA256SUMS`);
} else {
  console.error('usage: checksums.mjs write|verify');
  process.exit(2);
}
