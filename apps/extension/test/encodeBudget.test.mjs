/**
 * The quality search, against synthetic encoders.
 *
 * Real screenshots cannot be produced in this harness, so the encoder is
 * modelled as a monotonic size-versus-quality curve — which is the only
 * property the search relies on.
 */

import { encodeWithinBudget } from './.build/encodeBudget.js';

let failures = 0;
const ok = (name) => console.log(`ok   ${name}`);
const fail = (name, detail) => {
  failures += 1;
  console.error(`FAIL ${name}\n     ${detail}`);
};
const check = (name, cond, detail) => (cond ? ok(name) : fail(name, detail));

const KB = 1024;
const opts = { targetBytes: 30 * KB, minQuality: 0.3, maxQuality: 0.9, passes: 4 };

// A busy screen whose floor quality does fit: WebP size falls faster than
// linearly with quality, so q^1.5 off a 150 KB ceiling reaches ~25 KB at the
// 0.3 floor. This is the case the quality search alone can solve.
const busy = (q) => ({ size: Math.round(150 * KB * q ** 1.5), quality: q });
// An idle desktop: tiny at every quality.
const idle = (q) => ({ size: Math.round(12 * KB * q), quality: q });
// A pathological screen that never fits.
const huge = (q) => ({ size: Math.round(900 * KB * (0.5 + q / 2)), quality: q });

{
  const calls = [];
  const r = await encodeWithinBudget((q) => { calls.push(q); return Promise.resolve(busy(q)); }, opts);
  check('busy screen lands inside the budget', r.size <= opts.targetBytes, `got ${r.size}`);
  check('busy screen is not needlessly tiny', r.size > opts.targetBytes / 4, `got ${r.size}`);
  // One feasibility probe at the floor, then the bisection passes.
  check(
    'spends the probe plus the pass budget',
    calls.length === 5,
    `made ${calls.length} encodes`,
  );
  check('probes the quality floor first', calls[0] === opts.minQuality, `first was ${calls[0]}`);
  check(
    'every quality stays within bounds',
    calls.every((q) => q >= opts.minQuality && q <= opts.maxQuality),
    JSON.stringify(calls),
  );
}

{
  // Everything fits, so it must choose the best-looking frame, not the first.
  const r = await encodeWithinBudget((q) => Promise.resolve(idle(q)), opts);
  check('idle screen keeps the highest quality that fits', r.quality > 0.8, `quality ${r.quality}`);
}

{
  // Nothing fits: return the smallest rather than failing or returning the first.
  const r = await encodeWithinBudget((q) => Promise.resolve(huge(q)), opts);
  check('unfittable screen still yields a frame', r && r.size > 0, 'no blob returned');
  check(
    'unfittable screen yields the floor frame, the smallest achievable',
    r.quality === opts.minQuality,
    `quality ${r.quality}`,
  );
}

{
  // Quality alone cannot always reach the budget. The search says so by
  // returning an oversized frame rather than pretending; the capture layer
  // answers it by re-rendering the frame smaller.
  const r = await encodeWithinBudget(
    (q) => Promise.resolve({ size: Math.round(300 * KB * q), quality: q }),
    opts,
  );
  check(
    'reports an oversized frame when quality alone cannot fit',
    r.size > opts.targetBytes,
    `got ${r.size}, which would have hidden the need to downscale`,
  );
}

{
  // A frame exactly on the budget is acceptable, not one byte over the line.
  const r = await encodeWithinBudget(() => Promise.resolve({ size: opts.targetBytes }), opts);
  check('a frame exactly at the budget is accepted', r.size === opts.targetBytes, `got ${r.size}`);
}

for (const [name, bad] of [
  ['rejects a zero budget', { ...opts, targetBytes: 0 }],
  ['rejects inverted quality bounds', { ...opts, minQuality: 0.9, maxQuality: 0.3 }],
  ['rejects a zero pass count', { ...opts, passes: 0 }],
]) {
  let threw = false;
  try {
    await encodeWithinBudget((q) => Promise.resolve(busy(q)), bad);
  } catch {
    threw = true;
  }
  check(name, threw, 'no error thrown');
}

console.log(failures === 0 ? '\nencodeBudget: all passed' : `\nencodeBudget: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
