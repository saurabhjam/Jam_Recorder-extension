/**
 * Tests for writing a duration into a recorded WebM.
 *
 * Two properties matter, and the second one more than the first: the patched
 * file says how long it is, and anything this cannot parse with certainty is
 * left alone. A recording with no duration is awkward; a recording with a
 * corrupted header is gone.
 *
 * Run with `npm run test`.
 */

import { patchWebmHeader } from './.build/webmDuration.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (cond, m) => { if (!cond) throw new Error(m ?? 'expected true'); };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m}: ${a} not within ${tol} of ${b}`);

// ─── Building WebM headers to patch ───────────────────────────────────────────

const bytes = (...values) => Uint8Array.from(values.flat());

/** A size field of `length` bytes, as EBML encodes it. */
function size(value, length = 1) {
  const out = new Array(length).fill(0);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

const element = (id, content, sizeLength = 1) => [...id, ...size(content.length, sizeLength), ...content];

/** TimecodeScale, as MediaRecorder writes it: one million nanoseconds. */
const timecodeScale = (ns = 1_000_000) => element([0x2a, 0xd7, 0xb1], [
  (ns >> 16) & 0xff, (ns >> 8) & 0xff, ns & 0xff,
]);

const muxingApp = element([0x4d, 0x80], [...Buffer.from('Chrome')]);

function file({ withDuration = null, scale = 1_000_000, infoSizeLength = 1, segmentUnknown = true } = {}) {
  const ebml = element([0x1a, 0x45, 0xdf, 0xa3], [...element([0x42, 0x86], [0x01])]);
  const durationElement = withDuration == null
    ? []
    : [0x44, 0x89, 0x88, ...new Uint8Array(new Float64Array([withDuration]).buffer).reverse()];
  const info = element([0x15, 0x49, 0xa9, 0x66],
    [...timecodeScale(scale), ...muxingApp, ...durationElement], infoSizeLength);
  // A Cluster, standing in for the recording itself.
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], [0xa3, 0x81, 0x00]);
  const segmentSize = segmentUnknown ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    : size(info.length + cluster.length, 4);
  return bytes([0x18, 0x53, 0x80, 0x67].map(() => 0).length === 0 ? [] : [],
    ebml, [0x18, 0x53, 0x80, 0x67], segmentSize, info, cluster);
}

/** Read the Duration a patched header now carries, in timecode units. */
function readDuration(buffer) {
  for (let i = 0; i + 11 <= buffer.length; i++) {
    if (buffer[i] === 0x44 && buffer[i + 1] === 0x89 && buffer[i + 2] === 0x88) {
      return new DataView(buffer.buffer, buffer.byteOffset + i + 3, 8).getFloat64(0);
    }
  }
  return null;
}

/** Walk the patched header the way a player would, to prove it still parses. */
function parseInfo(buffer) {
  // EBML header
  let pos = 0;
  ok(buffer[0] === 0x1a, 'not an EBML file');
  const headerSize = buffer[4] & 0x7f;
  pos = 5 + headerSize;
  ok(buffer[pos] === 0x18, 'no Segment where one was expected');
  // Segment: 4-byte id, then its size
  let p = pos + 4;
  const first = buffer[p];
  let sizeLength = 1;
  let mask = 0x80;
  while ((first & mask) === 0) { mask >>= 1; sizeLength++; }
  p += sizeLength;
  // First child: Info
  ok(buffer[p] === 0x15, 'Info is not the first child any more');
  const infoSizeByte = buffer[p + 4];
  let infoSizeLength = 1;
  let m = 0x80;
  while ((infoSizeByte & m) === 0) { m >>= 1; infoSizeLength++; }
  let infoSize = infoSizeByte & (m - 1);
  for (let i = 1; i < infoSizeLength; i++) infoSize = infoSize * 256 + buffer[p + 4 + i];
  return { infoStart: p, infoContentStart: p + 4 + infoSizeLength, infoSize };
}

// ─── A recording with no duration, which is what MediaRecorder writes ─────────

t('a duration is added, and the file still parses', () => {
  const original = file();
  const patched = patchWebmHeader(original, 12.5);
  ok(patched, 'nothing was patched');

  const info = parseInfo(patched.header);
  // Info grew by exactly the element that was added.
  const before = parseInfo(original);
  eq(info.infoSize, before.infoSize + 11, 'Info size was not grown correctly');
  near(readDuration(patched.header), 12_500, 1, 'duration in timecode units (ms)');
});

t('the patched header replaces exactly the bytes it read', () => {
  const original = file();
  const patched = patchWebmHeader(original, 3);
  const before = parseInfo(original);
  eq(patched.consumed, before.infoContentStart + before.infoSize, 'wrong splice point');
  // Everything before Info is untouched.
  eq([...patched.header.subarray(0, before.infoStart)], [...original.subarray(0, before.infoStart)]);
});

t('a non-default timecode scale is honoured', () => {
  // Half-millisecond units: the same wall-clock duration is twice the number.
  const patched = patchWebmHeader(file({ scale: 500_000 }), 10);
  near(readDuration(patched.header), 20_000, 1, 'duration in half-ms units');
});

// ─── A recording that already has one ─────────────────────────────────────────

t('an existing duration is overwritten in place, with nothing moved', () => {
  const original = file({ withDuration: 1 });
  const patched = patchWebmHeader(original, 42);
  eq(patched.header.length, original.length - (original.length - patched.consumed),
    'the header changed length');
  eq(parseInfo(patched.header).infoSize, parseInfo(original).infoSize, 'Info was resized');
  near(readDuration(patched.header), 42_000, 1, 'duration');
});

// ─── Anything uncertain is left alone ─────────────────────────────────────────

t('a file that is not WebM is refused', () => {
  eq(patchWebmHeader(bytes([0x00, 0x01, 0x02, 0x03, 0x04]), 10), null);
  eq(patchWebmHeader(bytes([...Buffer.from('not a video at all')]), 10), null);
});

t('a header cut short anywhere inside Info is refused rather than guessed at', () => {
  const whole = file();
  const info = parseInfo(whole);
  // Cuts before and inside Info. (A file cut AFTER Info is still patchable:
  // the header is complete, which is all this reads.)
  for (const cut of [4, 10, 20, info.infoStart + 2, info.infoContentStart + 2]) {
    const result = patchWebmHeader(whole.subarray(0, cut), 10);
    ok(result === null, `patched a header cut at ${cut} bytes`);
  }
});

t('a duration that is not a real length is refused', () => {
  for (const value of [0, -5, NaN, Infinity]) {
    eq(patchWebmHeader(file(), value), null, `duration ${value}`);
  }
});

t('an Info whose size field cannot hold eleven more bytes is left alone', () => {
  // A one-byte size field maxes out at 126; this Info is already near it.
  const padding = new Array(120).fill(0x00);
  const info = element([0x15, 0x49, 0xa9, 0x66], [...timecodeScale(), ...padding]);
  const ebml = element([0x1a, 0x45, 0xdf, 0xa3], [...element([0x42, 0x86], [0x01])]);
  const whole = bytes(ebml, [0x18, 0x53, 0x80, 0x67], [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], info);
  eq(patchWebmHeader(whole, 10), null);
});

t('a segment of known size is patched the same way', () => {
  const patched = patchWebmHeader(file({ segmentUnknown: false }), 7);
  ok(patched, 'a sized segment was refused');
  near(readDuration(patched.header), 7_000, 1, 'duration');
});

t('a two-byte Info size field is rewritten at the same width', () => {
  const original = file({ infoSizeLength: 2 });
  const patched = patchWebmHeader(original, 9);
  ok(patched, 'refused a two-byte size');
  eq(parseInfo(patched.header).infoSize, parseInfo(original).infoSize + 11);
  near(readDuration(patched.header), 9_000, 1, 'duration');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
