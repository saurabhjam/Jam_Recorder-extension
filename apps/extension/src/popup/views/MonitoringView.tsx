/**
 * Screen monitoring controls, in the popup.
 *
 * ── The popup is a view, not the owner ───────────────────────────────────────
 * Every button sends an intent to the background and renders what comes back.
 * Nothing about the session lives here, so closing the popup — which happens
 * the instant the user clicks anywhere else — cannot disturb a running session.
 * On open it asks the background what is happening rather than assuming.
 *
 * ── It must never show a healthy status that is not true ─────────────────────
 * Session health and capture health are reported separately, because they fail
 * separately. A session can be perfectly alive on the server while the screen
 * stream is dead, and the old UI showed "Monitoring Active" throughout — so the
 * user believed their day was being recorded when nothing was being captured.
 * Capture status, queue depth and failed uploads each get their own line.
 *
 * ── Entire screen, not a choice ──────────────────────────────────────────────
 * Monitoring is whole-screen by definition. There is no Tab/Window/Screen
 * picker here (recording keeps its own); the copy states plainly what will be
 * shared, and the grant itself is restricted to screens.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Monitor,
  MonitorOff,
  Pause,
  Play,
  Square,
  Loader2,
  WifiOff,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatDuration } from '@/utils';
import { INITIAL_MONITORING_STATE, MONITORING_INTERVALS } from '@/types/monitoring';
import type { MonitoringInterval, MonitoringState } from '@/types/monitoring';
import {
  getAssignedProjects,
  resolveDefaultProject,
  setSelectedProject,
  type ProjectOption,
} from '@/services/projects';

function sendToBackground<T>(type: string, payload?: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }
      resolve(response as T);
    });
  });
}

/** Local clock for the elapsed readout, so it ticks between state pushes. */
function useElapsedSeconds(state: MonitoringState): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state.status !== 'monitoring') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.status]);

  if (!state.startedAt) return 0;
  const started = new Date(state.startedAt).getTime();
  // Paused time is excluded, matching what the server reports — otherwise the
  // popup and the daily report would disagree about the same session.
  const pausedNow =
    state.status === 'paused' && state.pausedAt
      ? Date.now() - new Date(state.pausedAt).getTime()
      : 0;
  return Math.max(0, Math.floor((now - started - state.pausedMs - pausedNow) / 1000));
}

function formatClock(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '—';
  }
}

/**
 * How the agent's state reads to a person.
 *
 * Screen capture and the agent fail independently, so this is computed and
 * displayed separately from captureLabel below. A broken agent must never make
 * screenshots look broken, and vice versa.
 *
 * `Applications: 0` is deliberately never a thing this returns. When the agent
 * is not connected the answer is "application tracking is unavailable", which
 * is a different statement from "no applications were used".
 */
function agentLabel(state: MonitoringState): {
  text: string;
  tone: 'ok' | 'warn' | 'idle';
  action?: 'install' | 'permission' | 'update';
  detail?: string;
} {
  const native = state.native;
  switch (native.status) {
    case 'monitoring':
    case 'connected':
      return {
        text: 'Connected',
        tone: 'ok',
        detail: native.capabilities?.windowTitle
          ? undefined
          : 'Window titles are unavailable, so applications are tracked without them.',
      };
    case 'connecting':
      return { text: 'Connecting…', tone: 'idle' };
    case 'permission-required':
      return {
        text: 'Permission required',
        tone: 'warn',
        action: 'permission',
        detail: native.error ?? 'The agent needs an OS permission to read the active application.',
      };
    case 'unsupported-platform':
      return {
        text: 'Not supported here',
        tone: 'warn',
        detail: native.error ?? 'This desktop session cannot report the active application.',
      };
    case 'outdated':
      return {
        text: 'Update required',
        tone: 'warn',
        action: 'update',
        detail: native.error ?? 'The installed agent is too old for this extension.',
      };
    case 'disconnected':
      return { text: 'Reconnecting…', tone: 'warn', detail: native.error ?? undefined };
    case 'unavailable':
      return {
        text: 'Not installed',
        tone: 'idle',
        action: 'install',
        detail: 'Applications and other Chrome profiles are not tracked without the agent.',
      };
    default:
      return { text: 'Not installed', tone: 'idle', action: 'install' };
  }
}

/** Which installer this machine needs. */
function installerHint(): string {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return 'BestQMonitoringAgentSetup.exe';
  if (/Mac/i.test(ua)) return 'BestQMonitoringAgent.pkg';
  return 'bestq-monitoring-agent.deb';
}

/** How the capture state reads to a person. */
function captureLabel(state: MonitoringState): { text: string; tone: 'ok' | 'warn' | 'idle' } {
  switch (state.capture.status) {
    case 'active':
    case 'capturing':
      return state.capture.trackLive
        ? { text: 'Connected', tone: 'ok' }
        : { text: 'Stream not live', tone: 'warn' };
    case 'requesting':
      return { text: 'Waiting for screen selection…', tone: 'idle' };
    case 'reconnect':
      return { text: 'Disconnected', tone: 'warn' };
    case 'failed':
      return { text: 'Failed', tone: 'warn' };
    default:
      return { text: 'Not capturing', tone: 'idle' };
  }
}

interface MonitoringViewProps {
  onBack: () => void;
}

export function MonitoringView({ onBack }: MonitoringViewProps) {
  const [state, setState] = useState<MonitoringState>(INITIAL_MONITORING_STATE);
  const [interval, setIntervalSeconds] = useState<MonitoringInterval>(60);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const elapsed = useElapsedSeconds(state);

  const refresh = useCallback(async () => {
    const next = await sendToBackground<MonitoringState>('MONITORING_GET_STATE');
    if (next) {
      setState(next);
      setIntervalSeconds(next.intervalSeconds ?? 60);
    }
  }, []);

  // Read real state on open — never create a session just because the popup
  // was opened.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Which projects this user may record into. A user can belong to several and
  // monitoring writes to exactly one, so the choice has to be theirs.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const options = await getAssignedProjects();
      if (cancelled) return;
      setProjects(options);
      setProject(await resolveDefaultProject(options));
      setProjectsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The background pushes state on every change; the popup follows it.
  useEffect(() => {
    const listener = (message: { type?: string; payload?: MonitoringState }) => {
      if (message.type === 'MONITORING_STATE_CHANGED' && message.payload) {
        setState(message.payload);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const run = useCallback(
    async (type: string, payload?: unknown) => {
      // A double click must not race the round trip. The background coalesces
      // duplicate starts anyway, but a second one would still open a second
      // screen picker.
      if (busy) return;
      setBusy(true);
      const next = await sendToBackground<MonitoringState>(type, payload);
      if (next) setState(next);
      setBusy(false);
    },
    [busy],
  );

  const isRunning = state.status === 'monitoring';
  const isPaused = state.status === 'paused';
  const isIdle = state.status === 'idle' || state.status === 'error';
  const isTransitioning = state.status === 'starting' || state.status === 'stopping';
  const capture = captureLabel(state);
  const agent = agentLabel(state);
  const captureBroken =
    isRunning && (state.capture.status === 'reconnect' || state.capture.status === 'failed');

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/8">
        <button
          type="button"
          onClick={onBack}
          className="text-dark-400 hover:text-white text-sm"
          aria-label="Back"
        >
          ‹
        </button>
        <Monitor size={16} className="text-jam-400" />
        <h2 className="text-sm font-semibold text-white">Screen Monitoring</h2>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-3">
        {/* Capture failure comes first: it invalidates everything else here. */}
        {captureBroken && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="flex items-start gap-2 text-xs font-semibold text-amber-200">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              Screen capture disconnected
            </p>
            <p className="text-[11px] leading-4 text-amber-100/80">
              No new screenshots are being captured. Everything already captured is safe, and
              activity is still being recorded.
            </p>
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              loading={busy}
              leftIcon={<MonitorOff size={14} />}
              onClick={() => run('MONITORING_RECONNECT_CAPTURE')}
            >
              Reconnect Screen
            </Button>
          </div>
        )}

        {(isRunning || isPaused) && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-white/10 bg-dark-800/60 p-4 space-y-3"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`w-2 h-2 rounded-full ${
                  isPaused || captureBroken
                    ? 'bg-amber-400'
                    : 'bg-green-400 animate-recording-pulse'
                }`}
              />
              <span className="text-sm font-semibold text-white">
                {isPaused ? 'Monitoring Paused' : 'Monitoring Active'}
              </span>
              {state.project && (
                <span className="px-1.5 py-0.5 rounded-md bg-jam-500/20 text-[10px] font-semibold text-jam-300">
                  {state.project}
                </span>
              )}
              {state.offlineSince && (
                <span
                  className="ml-auto flex items-center gap-1 text-[11px] text-amber-300"
                  title="Monitoring continues; data will sync automatically."
                >
                  <WifiOff size={11} />
                  Syncing
                </span>
              )}
            </div>

            {/*
              Two independent statuses. Screen capture and the activity agent
              can each fail on their own, and merging them would let one broken
              subsystem hide a working one — or a working one reassure the user
              about a broken one.
            */}
            <div className="space-y-1 rounded-lg bg-dark-900/50 px-2.5 py-2">
              <StatusRow label="Screen capture" tone={capture.tone} text={capture.text} />
              <StatusRow label="Activity agent" tone={agent.tone} text={agent.text} />
              {agent.detail && (
                <p className="pt-0.5 text-[10px] leading-3.5 text-dark-400">{agent.detail}</p>
              )}
              {agent.action === 'install' && (
                <p className="pt-0.5 text-[10px] leading-3.5 text-dark-400">
                  Install <span className="text-jam-300">{installerHint()}</span> to track
                  applications and other Chrome profiles.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Metric label="Monitoring time" value={formatDuration(elapsed)} />
              <Metric label="Screenshots" value={String(state.screenshotCount)} />
              <Metric label="Interval" value={`${state.intervalSeconds}s`} />
              <Metric
                label={isPaused ? 'Paused since' : 'Last screenshot'}
                value={isPaused ? formatClock(state.pausedAt) : formatClock(state.lastScreenshotAt)}
              />
              {!isPaused && (
                <Metric label="Next screenshot" value={formatClock(state.capture.nextCaptureAt)} />
              )}
              <Metric label="Activity" value={state.currentActivityLabel ?? '—'} />
            </div>

            {/* Queue depth is real information: these screenshots exist but have
                not reached the server yet. */}
            {state.queuedSnapshots > 0 && (
              <p className="flex items-center gap-1.5 text-[11px] text-amber-300">
                <AlertTriangle size={11} />
                {state.queuedSnapshots} screenshot{state.queuedSnapshots === 1 ? '' : 's'} waiting
                to upload
              </p>
            )}
            {state.failedSnapshots > 0 && (
              <p className="flex items-center gap-1.5 text-[11px] text-red-300">
                <AlertTriangle size={11} />
                {state.failedSnapshots} screenshot{state.failedSnapshots === 1 ? '' : 's'} could not
                be uploaded
              </p>
            )}
            {/* The reason, not just the count. A number on its own is not
                something anyone can act on, and the reason was otherwise
                readable only by opening the offscreen document's IndexedDB. */}
            {state.uploadError && (
              <p className="pl-[18px] text-[11px] leading-4 text-dark-400 break-words">
                {state.uploadError}
              </p>
            )}

            {isPaused && (
              <p className="text-[11px] leading-4 text-dark-400">
                Paused time is not counted as monitored time, and is not recorded as inactivity.
              </p>
            )}
          </motion.div>
        )}

        {isIdle && (
          <div className="rounded-xl border border-white/10 bg-dark-800/60 p-4 space-y-3">
            <div>
              <p className="text-sm font-semibold text-white">Entire Screen Monitoring</p>
              <p className="mt-1 text-xs text-dark-300 leading-5">
                Your entire screen will be monitored while monitoring is active. You will be asked
                which screen to share — monitoring always captures a whole screen, never a single
                tab or window.
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="monitoring-project"
                className="block text-[11px] font-semibold uppercase tracking-wide text-dark-400"
              >
                Project
              </label>
              {projectsLoading ? (
                <div className="h-9 rounded-lg bg-dark-900/60 animate-pulse" />
              ) : projects.length === 0 ? (
                <p className="text-xs text-amber-300">
                  Your account is not assigned to any project. Ask an administrator to add you to
                  one before monitoring.
                </p>
              ) : (
                <select
                  id="monitoring-project"
                  value={project ?? ''}
                  onChange={(event) => setProject(event.target.value)}
                  className="w-full h-9 px-2.5 rounded-lg bg-dark-900/80 border border-jam-500/20 text-sm text-white focus:outline-none focus:border-jam-500/60"
                >
                  {projects.map((option) => (
                    <option key={option.name} value={option.name}>
                      {option.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-[11px] font-semibold uppercase tracking-wide text-dark-400">
                Screenshot interval
              </legend>
              {MONITORING_INTERVALS.map((seconds) => (
                <label
                  key={seconds}
                  className="flex items-center gap-2 text-sm text-white cursor-pointer"
                >
                  <input
                    type="radio"
                    name="monitoring-interval"
                    value={seconds}
                    checked={interval === seconds}
                    onChange={() => setIntervalSeconds(seconds)}
                    className="accent-jam-500"
                  />
                  {seconds} seconds
                </label>
              ))}
            </fieldset>
          </div>
        )}

        {state.error && !captureBroken && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {state.error}
          </p>
        )}

        {confirmingStop && (
          <div className="rounded-xl border border-white/10 bg-dark-900 p-4 space-y-3">
            <p className="text-sm font-semibold text-white">Stop monitoring?</p>
            <div className="text-xs text-dark-300 space-y-1">
              <p>Monitoring has been active for {formatDuration(elapsed)}.</p>
              <p>{state.screenshotCount} screenshots captured.</p>
              {state.queuedSnapshots > 0 && (
                <p className="text-amber-300">
                  {state.queuedSnapshots} still uploading — these will be finished before stopping.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                onClick={() => setConfirmingStop(false)}
              >
                Continue
              </Button>
              <Button
                variant="danger"
                size="sm"
                fullWidth
                loading={busy}
                onClick={async () => {
                  setConfirmingStop(false);
                  await run('MONITORING_STOP');
                }}
              >
                Stop
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-white/8 flex gap-2">
        {isIdle && (
          <Button
            variant="primary"
            fullWidth
            loading={busy}
            disabled={!project || projectsLoading}
            leftIcon={<Monitor size={16} />}
            onClick={async () => {
              if (!project) return;
              // Persist before starting, so a retry after a failure — and the
              // next popup open — default to what the user just picked.
              await setSelectedProject(project);
              await run('MONITORING_START', { intervalSeconds: interval, project });
            }}
          >
            Start Monitoring
          </Button>
        )}

        {isRunning && (
          <>
            <Button
              variant="secondary"
              fullWidth
              disabled={busy}
              leftIcon={<Pause size={16} />}
              onClick={() => run('MONITORING_PAUSE')}
            >
              Pause
            </Button>
            <Button
              variant="danger"
              fullWidth
              disabled={busy}
              leftIcon={<Square size={14} />}
              onClick={() => setConfirmingStop(true)}
            >
              Stop
            </Button>
          </>
        )}

        {isPaused && (
          <>
            <Button
              variant="primary"
              fullWidth
              disabled={busy}
              leftIcon={<Play size={16} />}
              onClick={() => run('MONITORING_RESUME')}
            >
              Resume
            </Button>
            <Button
              variant="danger"
              fullWidth
              disabled={busy}
              leftIcon={<Square size={14} />}
              onClick={() => setConfirmingStop(true)}
            >
              Stop
            </Button>
          </>
        )}

        {isTransitioning && (
          <Button variant="secondary" fullWidth disabled leftIcon={<Loader2 size={16} />}>
            {state.status === 'starting' ? 'Starting…' : 'Saving…'}
          </Button>
        )}
      </div>
    </div>
  );
}

function StatusRow({
  label,
  tone,
  text,
}: {
  label: string;
  tone: 'ok' | 'warn' | 'idle';
  text: string;
}) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-dark-400">{label}</span>
      <span
        className={
          tone === 'ok' ? 'text-green-300' : tone === 'warn' ? 'text-amber-300' : 'text-dark-400'
        }
      >
        {tone === 'ok' && <CheckCircle2 size={10} className="inline mr-1" />}
        {text}
      </span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-dark-400">
        {label}
      </span>
      <span className="text-sm font-bold text-white tabular-nums truncate" title={value}>
        {value}
      </span>
    </div>
  );
}
