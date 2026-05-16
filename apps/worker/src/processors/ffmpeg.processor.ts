import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

// Set FFmpeg paths if specified in env
if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

export interface VideoOptions {
  width?: number;
  height?: number;
  videoBitrate?: string; // e.g. '2000k'
  audioBitrate?: string; // e.g. '128k'
  fps?: number;
  format?: string;
  crf?: number; // Quality: lower = better, 18-28 typical
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  format: string;
  size: number;
  hasAudio: boolean;
}

export interface ProgressEvent {
  percent: number;
  timemark: string;
}

/** Run an ffmpeg command wrapped in a promise with progress callback */
function runFfmpeg(
  cmd: ffmpeg.FfmpegCommand,
  label: string,
  onProgress?: (ev: ProgressEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    cmd
      .on('start', (cmdLine) => {
        logger.debug(`[FFmpeg] ${label} — starting`, { cmdLine });
      })
      .on('progress', (progress: ProgressEvent) => {
        onProgress?.(progress);
        if (progress.percent) {
          logger.debug(`[FFmpeg] ${label} — ${progress.percent.toFixed(1)}%`);
        }
      })
      .on('end', () => {
        logger.info(`[FFmpeg] ${label} — done`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        logger.error(`[FFmpeg] ${label} — error`, {
          error: err.message,
          stderr: stderr?.slice(-500),
        });
        reject(new Error(`FFmpeg failed (${label}): ${err.message}`));
      })
      .run();
  });
}

/**
 * Merge multiple video chunk files into a single file.
 * Uses the concat demuxer for fast, lossless merging.
 */
export async function mergeVideoChunks(
  inputPaths: string[],
  outputPath: string,
  onProgress?: (ev: ProgressEvent) => void,
): Promise<void> {
  if (inputPaths.length === 0) throw new Error('No input chunks provided');
  if (inputPaths.length === 1) {
    // Single chunk — just copy it
    await fs.copyFile(inputPaths[0], outputPath);
    return;
  }

  // Write concat list file
  const tmpDir = path.dirname(outputPath);
  const listFile = path.join(tmpDir, `concat_${Date.now()}.txt`);
  const listContent = inputPaths.map((p) => `file '${p}'`).join('\n');
  await fs.writeFile(listFile, listContent, 'utf-8');

  try {
    const cmd = ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(outputPath);

    await runFfmpeg(cmd, 'mergeChunks', onProgress);
  } finally {
    await fs.unlink(listFile).catch(() => {});
  }
}

/**
 * Optimize a video: re-encode with target resolution/bitrate.
 * Produces an H.264/AAC MP4 optimized for web streaming.
 */
export async function optimizeVideo(
  inputPath: string,
  outputPath: string,
  options: VideoOptions = {},
  onProgress?: (ev: ProgressEvent) => void,
): Promise<void> {
  const {
    width = 1280,
    height = 720,
    videoBitrate = '2000k',
    audioBitrate = '128k',
    fps = 30,
    crf = 23,
    format = 'mp4',
  } = options;

  const outputOptions: string[] = [
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    String(crf),
    '-maxrate',
    videoBitrate,
    '-bufsize',
    `${parseInt(videoBitrate) * 2}k`,
    '-c:a',
    'aac',
    '-b:a',
    audioBitrate,
    '-movflags',
    '+faststart', // Enable streaming from the start
    '-pix_fmt',
    'yuv420p', // Ensure broad compatibility
  ];

  const videoFilter = `scale='if(gt(iw,${width}),${width},-2)':'if(gt(ih,${height}),${height},-2)'`;

  const cmd = ffmpeg(inputPath)
    .videoFilter(videoFilter)
    .fps(fps)
    .outputOptions(outputOptions)
    .format(format)
    .output(outputPath);

  await runFfmpeg(cmd, 'optimizeVideo', onProgress);
}

/**
 * Extract a thumbnail frame from a video at a given timestamp.
 */
export async function extractThumbnail(
  videoPath: string,
  outputPath: string,
  time = 1, // seconds
  width = 1280,
  height = 720,
): Promise<void> {
  const cmd = ffmpeg(videoPath)
    .seekInput(time)
    .frames(1)
    .videoFilter(`scale='if(gt(iw,${width}),${width},-2)':'if(gt(ih,${height}),${height},-2)'`)
    .output(outputPath)
    .format('image2');

  await runFfmpeg(cmd, 'extractThumbnail');
}

/**
 * Get video metadata using ffprobe.
 */
export async function getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(new Error(`ffprobe error: ${err.message}`));

      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');
      const format = metadata.format;

      if (!videoStream) return reject(new Error('No video stream found'));

      const fpsStr = videoStream.r_frame_rate ?? '30/1';
      const [num, den] = fpsStr.split('/').map(Number);
      const fps = den > 0 ? num / den : 30;

      resolve({
        duration: parseFloat(String(format.duration ?? 0)),
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        fps: Math.round(fps),
        videoBitrate: parseInt(String(videoStream.bit_rate ?? 0)),
        audioBitrate: parseInt(String(audioStream?.bit_rate ?? 0)),
        format: format.format_name ?? '',
        size: parseInt(String(format.size ?? 0)),
        hasAudio: !!audioStream,
      });
    });
  });
}

/**
 * Convert a video to a different format.
 */
export async function convertFormat(
  inputPath: string,
  outputPath: string,
  format: string,
  onProgress?: (ev: ProgressEvent) => void,
): Promise<void> {
  const cmd = ffmpeg(inputPath).outputOptions(['-c', 'copy']).format(format).output(outputPath);

  await runFfmpeg(cmd, `convertFormat(${format})`, onProgress);
}

/**
 * Create a short GIF preview from a video (first 3 seconds).
 */
export async function createGifPreview(
  inputPath: string,
  outputPath: string,
  duration = 3,
  width = 480,
): Promise<void> {
  const cmd = ffmpeg(inputPath)
    .duration(duration)
    .videoFilter(
      [
        `fps=12`,
        `scale=${width}:-1:flags=lanczos`,
        `split[s0][s1]`,
        `[s0]palettegen=max_colors=128[p]`,
        `[s1][p]paletteuse=dither=bayer`,
      ].join(','),
    )
    .output(outputPath)
    .format('gif');

  await runFfmpeg(cmd, 'createGifPreview');
}

/**
 * Check if FFmpeg is available on the system.
 */
export async function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err) => resolve(!err));
  });
}
