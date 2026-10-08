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
    resolve(here, '..', 'src', 'utils', 'authRefreshPolicy.ts'),
    resolve(here, '..', 'src', 'utils', 'sessionLifetime.ts'),
    resolve(here, '..', 'src', 'utils', 'monitoringBadge.ts'),
    resolve(here, '..', 'src', 'utils', 'recordingUploadPolicy.ts'),
    resolve(here, '..', 'src', 'utils', 'webmDuration.ts'),
    resolve(here, '..', 'src', 'utils', 'fullPagePlan.ts'),
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
execFileSync(process.execPath, [resolve(here, 'authRefreshPolicy.test.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [resolve(here, 'sessionLifetime.test.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [resolve(here, 'monitoringBadge.test.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [resolve(here, 'recordingUploadPolicy.test.mjs')], {
  stdio: 'inherit',
});
execFileSync(process.execPath, [resolve(here, 'webmDuration.test.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [resolve(here, 'fullPagePlan.test.mjs')], { stdio: 'inherit' });

// The real background code end to end, against a simulated agent, OS, server
// and chrome.*. Skips itself, with a note, when fake-indexeddb is not available.
execFileSync(process.execPath, [resolve(here, 'e2e', 'monitoring.e2e.test.mjs')], {
  stdio: 'inherit',
});

// The recording upload queue against a simulated server, offscreen document
// and clock: server outages, lapsed sign-ins, crashes, duplicates, trimming.
execFileSync(process.execPath, [resolve(here, 'e2e', 'uploads.e2e.test.mjs')], {
  stdio: 'inherit',
});

// Runs against dist/, so it only means anything after a build — which is
// precisely when it matters, because this is the check a build cannot make.
execFileSync(process.execPath, [resolve(here, 'workerLoads.test.mjs')], { stdio: 'inherit' });
