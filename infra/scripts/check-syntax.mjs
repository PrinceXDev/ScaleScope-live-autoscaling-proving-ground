#!/usr/bin/env node
/**
 * `npm run check` — a syntax pass over every service and package file.
 *
 * This is deliberately not a linter and not a test runner: it's the fastest
 * possible signal ("does this parse at all") to run before pushing to Zerops,
 * where a syntax error surfaces as a container that boots and immediately
 * exits, several minutes and one deploy cycle later than finding out here.
 * Real behavioural confidence comes from actually running the stack — see
 * README.md "Running locally" and TESTING.md for what that looks like.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collectJsFiles(full, out);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.jsx')) out.push(full);
  }
  return out;
}

async function main() {
  const files = [
    ...collectJsFiles(join(ROOT, 'apps')),
    ...collectJsFiles(join(ROOT, 'packages')),
    ...collectJsFiles(join(ROOT, 'infra')),
  ].filter((f) => !f.endsWith('.jsx')); // node --check doesn't parse JSX; Vite's build already covers apps/web

  let failures = 0;
  for (const file of files) {
    try {
      await exec(process.execPath, ['--check', file]);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${relative(ROOT, file)}`);
      console.error(err.stderr || err.message);
    }
  }

  console.log(`\n${files.length - failures}/${files.length} files OK`);
  if (failures > 0) {
    console.log('Run `npm run build:web` separately to check the React/JSX side.');
    process.exit(1);
  }
}

main();
