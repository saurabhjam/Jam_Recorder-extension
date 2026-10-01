/**
 * Write a real duration into a recorded WebM.
 *
 * MediaRecorder streams WebM: it cannot know how long the recording will be, so
 * it writes no Duration at all. Every player then reports `Infinity` — which is
 * why a saved recording shows 00:00 and why dragging the progress bar does
 * nothing: with no duration there is no timeline to seek within, and the
 * browser will only play forwards from where it already is.
 *
 * The fix is to put the duration in after the fact. Only the file's header
 * needs touching — a few hundred bytes — so the recording itself is never read
 * into memory or rewritten; the patched header is simply joined to the
 * untouched remainder.
 *
 * Everything here returns null rather than guessing when the bytes are not what
 * it expects. A recording that cannot be patched is uploaded exactly as it was
 * recorded: a missing duration is a nuisance, and a corrupted video is a loss.
 */

/** EBML element ids, with their leading marker bits, as they appear on disk. */
const ID = {
  EBML_HEADER: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
} as const;

/** Nanoseconds per timecode unit when a file does not say otherwise. */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

/** How much of the file to look at. The header sits at the very front. */
export const HEADER_SCAN_BYTES = 256 * 1024;

interface Element {
  id: number;
  /** Where the element's id starts. */
  start: number;
  /** Where its content starts. */
  dataStart: number;
  /** Content length, or null when the file declares it unknown. */
  size: number | null;
  /** Bytes used to encode the size. */
  sizeLength: number;
}

/** Read an element id: 1–4 bytes, marker bits kept. */
function readId(bytes: Uint8Array, pos: number): { id: number; length: number } | null {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  const length = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
  if (length === 0 || pos + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[pos + i];
  return { id, length };
}

/** Read a size: 1–8 bytes, marker stripped. All-ones means "unknown". */
function readSize(bytes: Uint8Array, pos: number): { size: number | null; length: number } | null {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || pos + length > bytes.length) return null;

  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? null : value, length };
}

function readElement(bytes: Uint8Array, pos: number): Element | null {
  const id = readId(bytes, pos);
  if (!id) return null;
  const size = readSize(bytes, pos + id.length);
  if (!size) return null;
  return {
    id: id.id,
    start: pos,
    dataStart: pos + id.length + size.length,
    size: size.size,
    sizeLength: size.length,
  };
}

/** Encode a size into exactly `length` bytes, or null when it will not fit. */
function writeSize(value: number, length: number): Uint8Array | null {
  const capacity = 2 ** (7 * length) - 1;
  if (value >= capacity) return null;
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

interface Located {
  info: Element;
  /** Content end of Info. */
  infoEnd: number;
  duration: Element | null;
  timecodeScale: number;
}

/** Find the Info element and what it already says. */
function locate(bytes: Uint8Array): Located | null {
  let pos = 0;
  const header = readElement(bytes, pos);
  if (!header || header.id !== ID.EBML_HEADER || header.size == null) return null;
  pos = header.dataStart + header.size;

  const segment = readElement(bytes, pos);
  if (!segment || segment.id !== ID.SEGMENT) return null;

  // Walk the Segment's children until Info turns up. A child of unknown size
  // cannot be stepped over, so the search stops rather than guessing.
  let child = segment.dataStart;
  while (child < bytes.length) {
    const element = readElement(bytes, child);
    if (!element || element.size == null) return null;
    if (element.id === ID.INFO) {
      const infoEnd = element.dataStart + element.size;
      if (infoEnd > bytes.length) return null;

      let duration: Element | null = null;
      let timecodeScale = DEFAULT_TIMECODE_SCALE;
      let inner = element.dataStart;
      while (inner < infoEnd) {
        const field = readElement(bytes, inner);
        if (!field || field.size == null) return null;
        if (field.id === ID.DURATION) duration = field;
        if (field.id === ID.TIMECODE_SCALE) {
          let scale = 0;
          for (let i = 0; i < field.size; i++) scale = scale * 256 + bytes[field.dataStart + i];
          if (scale > 0) timecodeScale = scale;
        }
        inner = field.dataStart + field.size;
      }
      return { info: element, infoEnd, duration, timecodeScale };
    }
    child = element.dataStart + element.size;
  }
  return null;
}

/**
 * Patch the duration into a WebM header.
 *
 * @param head  the first bytes of the file — enough to contain its header.
 * @returns the rewritten header and how many bytes of the original it replaces,
 *          or null when the bytes are not a WebM this can safely edit.
 */
export function patchWebmHeader(
  head: Uint8Array,
  durationSeconds: number,
): { header: Uint8Array; consumed: number } | null {
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) return null;
  const found = locate(head);
  if (!found) return null;

  const scaled = (durationSeconds * 1_000_000_000) / found.timecodeScale;

  // Already has one: overwrite it in place, so nothing moves and no size
  // anywhere has to change.
  if (found.duration && (found.duration.size === 4 || found.duration.size === 8)) {
    const header = head.slice(0, found.infoEnd);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (found.duration.size === 8) view.setFloat64(found.duration.dataStart, scaled);
    else view.setFloat32(found.duration.dataStart, scaled);
    return { header, consumed: found.infoEnd };
  }

  // Otherwise add one, and grow Info by exactly what was added: two bytes of
  // id, one of size, eight of float.
  const addition = new Uint8Array(11);
  addition[0] = 0x44;
  addition[1] = 0x89;
  addition[2] = 0x88; // an 8-byte payload
  new DataView(addition.buffer).setFloat64(3, scaled);

  const infoSize = found.info.size;
  if (infoSize == null) return null;
  const resized = writeSize(infoSize + addition.length, found.info.sizeLength);
  // Growing the size field would shift everything after it, including offsets
  // the file's own index may refer to. Not worth the risk.
  if (!resized) return null;

  const header = new Uint8Array(found.infoEnd + addition.length);
  header.set(head.subarray(0, found.infoEnd), 0);
  // Rewrite Info's size, then slot the Duration in at the front of its content.
  const sizeAt = found.info.dataStart - found.info.sizeLength;
  header.set(resized, sizeAt);
  header.set(addition, found.info.dataStart);
  header.set(
    head.subarray(found.info.dataStart, found.infoEnd),
    found.info.dataStart + addition.length,
  );
  return { header, consumed: found.infoEnd };
}

/**
 * A copy of `blob` that knows how long it is.
 *
 * Returns the original blob unchanged when it cannot be patched — the caller
 * always gets something uploadable.
 */
export async function withWebmDuration(blob: Blob, durationSeconds: number): Promise<Blob> {
  try {
    if (!blob.type.includes('webm')) return blob;
    const head = new Uint8Array(await blob.slice(0, HEADER_SCAN_BYTES).arrayBuffer());
    const patched = patchWebmHeader(head, durationSeconds);
    if (!patched) return blob;
    return new Blob([patched.header as BlobPart, blob.slice(patched.consumed)], {
      type: blob.type,
    });
  } catch (err) {
    console.warn('[WebM] could not write the duration into the recording:', err);
    return blob;
  }
}
