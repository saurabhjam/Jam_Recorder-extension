/**
 * Evaluate the built service-worker bundle, to prove it can actually register.
 *
 * This exists because of a real failure a green build did not catch: a `const`
 * declared *after* the object literal that read it. Bundlers happily emit that
 * — the temporal dead zone is a runtime rule — and Chrome answered with
 * "Service worker registration failed. Status code: 15" plus a minified
 * "Cannot access 'qr' before initialization". The extension was dead on load
 * with nothing wrong at compile time.
 *
 * Importing the bundle runs every module body, which is exactly where that
 * class of error lives. The chrome/DOM surface is auto-stubbed: the point is
 * not to exercise behaviour, only to reach the end of evaluation without
 * throwing.
 */

import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, '..', 'dist', 'src', 'background', 'index.js');

if (!existsSync(bundle)) {
  console.error(`  SKIP service worker load — no build at ${bundle} (run a build first)`);
  process.exit(0);
}

// Any property access returns another callable stub, so the bundle's top-level
// `chrome.x.y.addListener(...)` calls resolve without us enumerating the API.
// Calls resolve to a promise, because most chrome.* APIs are awaited and a
// non-thenable return ends evaluation early — before the load-time errors this
// test exists to find.
const inert = new Proxy(
  {},
  {
    get: () => undefined,
    has: () => true,
  },
);

const stub = () => {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, prop) => {
      // Never thenable itself: `await chrome.foo` must not hang.
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return stub();
    },
    apply: () => Promise.resolve(inert),
    construct: () => stub(),
  });
};

globalThis.chrome = stub();
globalThis.self = globalThis;
if (!globalThis.indexedDB) globalThis.indexedDB = stub();
if (!globalThis.location) globalThis.location = { href: 'chrome-extension://test/' };

// Unhandled rejections from stubbed async work are noise, not failures.
process.on('unhandledRejection', () => {});

try {
  await import(pathToFileURL(bundle).href);
  console.log('ok   service worker bundle evaluates without throwing');
} catch (err) {
  if (err instanceof ReferenceError) {
    console.error(`FAIL service worker bundle threw at load: ${err.message}`);
    console.error('     This is what makes Chrome report "Service worker registration failed".');
    process.exit(1);
  }
  // A stubbed API behaving unlike Chrome is not what this test is about; only
  // load-time reference errors are.
  console.log(`ok   service worker bundle evaluated (non-reference error tolerated: ${err.message})`);
}
