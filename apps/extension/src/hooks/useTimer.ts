import { useState, useEffect, useRef, useCallback } from 'react';
import { formatDuration } from '@/utils';

interface UseTimerOptions {
  initialSeconds?: number;
  autoStart?: boolean;
}

interface UseTimerReturn {
  seconds: number;
  formattedTime: string;
  isRunning: boolean;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  set: (seconds: number) => void;
}

export function useTimer({
  initialSeconds = 0,
  autoStart = false,
}: UseTimerOptions = {}): UseTimerReturn {
  const [seconds, setSeconds] = useState(initialSeconds);
  const [isRunning, setIsRunning] = useState(autoStart);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearInterval_ = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    setIsRunning(true);
  }, []);

  const pause = useCallback(() => {
    setIsRunning(false);
    clearInterval_();
  }, [clearInterval_]);

  const resume = useCallback(() => {
    setIsRunning(true);
  }, []);

  const reset = useCallback(() => {
    setIsRunning(false);
    clearInterval_();
    setSeconds(initialSeconds);
  }, [clearInterval_, initialSeconds]);

  const set = useCallback((s: number) => {
    setSeconds(s);
  }, []);

  useEffect(() => {
    if (isRunning) {
      intervalRef.current = setInterval(() => {
        setSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      clearInterval_();
    }

    return clearInterval_;
  }, [isRunning, clearInterval_]);

  // Cleanup on unmount
  useEffect(() => {
    return clearInterval_;
  }, [clearInterval_]);

  return {
    seconds,
    formattedTime: formatDuration(seconds),
    isRunning,
    start,
    pause,
    resume,
    reset,
    set,
  };
}
