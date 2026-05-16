import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipBack,
  SkipForward,
  Settings,
} from 'lucide-react';
import { cn, formatDuration, clamp } from '@utils/index';

interface VideoPlayerProps {
  src: string;
  title?: string;
  poster?: string;
  className?: string;
  onEnded?: () => void;
  onTimeUpdate?: (time: number) => void;
}

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function VideoPlayer({
  src,
  title,
  poster,
  className,
  onEnded,
  onTimeUpdate,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [seeking, setSeeking] = useState(false);

  const hideControlsTimer = useRef<ReturnType<typeof setTimeout>>();

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const resetHideTimer = useCallback(() => {
    clearTimeout(hideControlsTimer.current);
    setShowControls(true);
    if (playing) {
      hideControlsTimer.current = setTimeout(() => setShowControls(false), 2500);
    }
  }, [playing]);

  // ─── Video events ─────────────────────────────────────────────────────────

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdateHandler = () => {
      setCurrentTime(video.currentTime);
      onTimeUpdate?.(video.currentTime);
      // Buffered
      if (video.buffered.length > 0) {
        setBuffered((video.buffered.end(video.buffered.length - 1) / video.duration) * 100);
      }
    };
    const onLoadedMetadata = () => setDuration(video.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded_ = () => {
      setPlaying(false);
      onEnded?.();
    };

    video.addEventListener('timeupdate', onTimeUpdateHandler);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded_);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdateHandler);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded_);
    };
  }, [onEnded, onTimeUpdate]);

  // ─── Fullscreen listener ──────────────────────────────────────────────────

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seek(-5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seek(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          adjustVolume(0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustVolume(-0.1);
          break;
        case 'm':
          toggleMute();
          break;
        case 'f':
          toggleFullscreen();
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ─── Controls ─────────────────────────────────────────────────────────────

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
    resetHideTimer();
  };

  const seek = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clamp(video.currentTime + delta, 0, video.duration);
  };

  const adjustVolume = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const newVol = clamp(video.volume + delta, 0, 1);
    video.volume = newVol;
    setVolume(newVol);
    setMuted(newVol === 0);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(!muted);
  };

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      await container.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  };

  const setPlaybackSpeed = (s: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = s;
    setSpeed(s);
    setShowSettings(false);
  };

  // ─── Progress bar ─────────────────────────────────────────────────────────

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = progressRef.current;
    const video = videoRef.current;
    if (!bar || !video) return;
    const rect = bar.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    video.currentTime = ratio * video.duration;
  };

  const progressPercent = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className={cn('relative bg-black rounded-xl overflow-hidden group select-none', className)}
      onMouseMove={resetHideTimer}
      onMouseLeave={() => playing && setShowControls(false)}
    >
      {/* Video */}
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        className="w-full h-full object-contain"
        onClick={togglePlay}
        playsInline
      />

      {/* Big play button overlay */}
      {!playing && (
        <div
          className="absolute inset-0 flex items-center justify-center cursor-pointer"
          onClick={togglePlay}
        >
          <div className="bg-white/10 backdrop-blur-sm rounded-full p-5 hover:bg-white/20 transition-colors">
            <Play className="h-8 w-8 text-white ml-1" />
          </div>
        </div>
      )}

      {/* Controls overlay */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 transition-opacity duration-300',
          showControls || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      >
        {/* Gradient */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent pointer-events-none" />

        <div className="relative px-4 pb-4 pt-12 space-y-2">
          {/* Progress bar */}
          <div
            ref={progressRef}
            className="relative h-1 rounded-full bg-white/20 cursor-pointer group/progress hover:h-1.5 transition-all duration-100"
            onClick={handleProgressClick}
          >
            {/* Buffered */}
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-white/30"
              style={{ width: `${buffered}%` }}
            />
            {/* Progress */}
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-violet-500"
              style={{ width: `${progressPercent}%` }}
            >
              {/* Thumb */}
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow opacity-0 group-hover/progress:opacity-100 transition-opacity" />
            </div>
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-3">
            {/* Skip back */}
            <button
              onClick={() => seek(-10)}
              className="text-white/70 hover:text-white transition-colors"
              title="Rewind 10s"
            >
              <SkipBack className="h-4 w-4" />
            </button>

            {/* Play/Pause */}
            <button
              onClick={togglePlay}
              className="text-white hover:text-violet-300 transition-colors"
            >
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </button>

            {/* Skip forward */}
            <button
              onClick={() => seek(10)}
              className="text-white/70 hover:text-white transition-colors"
              title="Forward 10s"
            >
              <SkipForward className="h-4 w-4" />
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1.5 group/vol">
              <button
                onClick={toggleMute}
                className="text-white/70 hover:text-white transition-colors"
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (videoRef.current) videoRef.current.volume = v;
                  setVolume(v);
                  setMuted(v === 0);
                }}
                className="w-16 h-1 appearance-none bg-white/30 rounded-full cursor-pointer accent-violet-500 hidden group-hover/vol:block"
              />
            </div>

            {/* Time */}
            <span className="text-xs text-white/70 font-mono tabular-nums">
              {formatDuration(currentTime)} / {formatDuration(duration)}
            </span>

            <div className="flex-1" />

            {/* Speed */}
            <div className="relative">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="flex items-center gap-1 text-xs text-white/70 hover:text-white transition-colors px-1.5 py-0.5 rounded"
              >
                <Settings className="h-3.5 w-3.5" />
                {speed}x
              </button>
              {showSettings && (
                <div className="absolute bottom-full right-0 mb-2 bg-gray-900 border border-white/[0.08] rounded-xl p-1.5 shadow-xl min-w-[100px]">
                  {PLAYBACK_SPEEDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setPlaybackSpeed(s)}
                      className={cn(
                        'w-full text-left text-xs px-3 py-1.5 rounded-lg transition-colors',
                        s === speed
                          ? 'text-violet-400 bg-violet-400/10'
                          : 'text-gray-400 hover:text-gray-100 hover:bg-white/[0.06]',
                      )}
                    >
                      {s === 1 ? 'Normal' : `${s}x`}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Fullscreen */}
            <button
              onClick={toggleFullscreen}
              className="text-white/70 hover:text-white transition-colors"
            >
              {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
