/**
 * What a video file says about itself: how long it is, and a frame to show.
 *
 * Needed for videos the extension did not record. A file picked from disk
 * arrives as bytes and nothing else, and until something actually loads it,
 * the library has no length to print (so it showed 00:00) and no still to show
 * (so the card was blank). Both are read here, from the file itself, before the
 * editor ever opens.
 *
 * Everything is bounded and every failure is survivable: a probe that cannot
 * read a file returns nothing, and the upload goes ahead without it.
 */

export interface VideoProbe {
  /** Seconds, or null when the file will not say. */
  durationSeconds: number | null;
  /** A JPEG data URL, or null. */
  thumbnailDataUrl: string | null;
}

const METADATA_TIMEOUT_MS = 15_000;
const FRAME_TIMEOUT_MS = 10_000;
const THUMBNAIL_WIDTH = 640;

function once(element: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      element.removeEventListener(event, handler);
      clearTimeout(timer);
      resolve(value);
    };
    const handler = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    element.addEventListener(event, handler, { once: true });
  });
}

/**
 * Coax a real duration out of a file that reports `Infinity`.
 *
 * WebM written by a recorder carries no duration. Seeking past the end makes
 * the browser scan for the real one, which is the only way to learn it without
 * decoding the file.
 */
async function resolveDuration(video: HTMLVideoElement): Promise<number | null> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  const learned = new Promise<number | null>((resolve) => {
    const onChange = () => {
      if (!Number.isFinite(video.duration)) return;
      video.removeEventListener('durationchange', onChange);
      resolve(video.duration > 0 ? video.duration : null);
    };
    video.addEventListener('durationchange', onChange);
    setTimeout(() => {
      video.removeEventListener('durationchange', onChange);
      resolve(null);
    }, METADATA_TIMEOUT_MS);
  });
  try {
    video.currentTime = 1e101;
  } catch {
    return null;
  }
  const duration = await learned;
  try {
    video.currentTime = 0;
  } catch {
    /* it has served its purpose either way */
  }
  return duration;
}

/** Draw the frame the video is currently showing. */
function grabFrame(video: HTMLVideoElement): string | null {
  try {
    const width = Math.min(THUMBNAIL_WIDTH, video.videoWidth || THUMBNAIL_WIDTH);
    const scale = video.videoWidth > 0 ? width / video.videoWidth : 1;
    const height = Math.round((video.videoHeight || 360) * scale) || 360;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // A file from another origin would taint the canvas; a local one cannot,
    // but a decoder that has produced no frame yet also lands here.
    return null;
  }
}

/**
 * Read a video file's length and a representative frame.
 *
 * The frame is taken a little way in rather than at the very start, where most
 * recordings are still a blank page or a fade.
 */
export async function probeVideoFile(file: Blob): Promise<VideoProbe> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    if (!(await once(video, 'loadedmetadata', METADATA_TIMEOUT_MS))) {
      return { durationSeconds: null, thumbnailDataUrl: null };
    }
    const durationSeconds = await resolveDuration(video);

    // A tenth of the way in, capped — far enough past the opening frame to show
    // something, close enough to the start to be quick on a long file.
    const at = durationSeconds ? Math.min(durationSeconds * 0.1, 3) : 0;
    const seeked = once(video, 'seeked', FRAME_TIMEOUT_MS);
    try {
      video.currentTime = at;
    } catch {
      /* fall through to whatever frame is up */
    }
    await seeked;
    return { durationSeconds, thumbnailDataUrl: grabFrame(video) };
  } catch {
    return { durationSeconds: null, thumbnailDataUrl: null };
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
}
