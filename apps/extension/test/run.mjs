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
    resolve(here, '..', 'src', 'utils', 'encodeBudget.ts'),
    resolve(here, '..', 'src', 'utils', 'monitoringSyncPolicy.ts'),
    resolve(here, '..', 'src', 'utils', 'monitoringInactivity.ts'),
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
execFileSync(process.execPath, [resolve(here, 'encodeBudget.test.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [resolve(here, 'monitoringSyncPolicy.test.mjs')], {
  stdio: 'inherit',
});
execFileSync(process.execPath, [resolve(here, 'monitoringInactivity.test.mjs')], {
  stdio: 'inherit',
});

// The real background code end to end, against a simulated agent, OS, server
// and chrome.*. Skips itself, with a note, when fake-indexeddb is not available.
execFileSync(process.execPath, [resolve(here, 'e2e', 'monitoring.e2e.test.mjs')], {
  stdio: 'inherit',
});

// Runs against dist/, so it only means anything after a build — which is
// precisely when it matters, because this is the check a build cannot make.
execFileSync(process.execPath, [resolve(here, 'workerLoads.test.mjs')], { stdio: 'inherit' });
