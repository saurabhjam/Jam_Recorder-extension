#!/usr/bin/env node
/**
 * Compile the pure monitoring helpers, then run their tests against the real
 * compiled output.
 *
 * Deliberately not a test framework: this repository has none, and the modules
 * worth testing here are pure functions with no DOM or chrome.* dependency, so
 * `tsc` plus node is the whole requirement.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '.build');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

execFileSync(
  'npx',
  [
    'tsc',
    resolve(here, '..', 'src', 'utils', 'captureSchedule.ts'),
    '--outDir',
    outDir,
    '--module',
    'es2022',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
  ],
  { stdio: 'inherit' },
);

execFileSync(process.execPath, [resolve(here, 'captureSchedule.test.mjs')], { stdio: 'inherit' });

// Runs against dist/, so it only means anything after a build — which is
// precisely when it matters, because this is the check a build cannot make.
execFileSync(process.execPath, [resolve(here, 'workerLoads.test.mjs')], { stdio: 'inherit' });
