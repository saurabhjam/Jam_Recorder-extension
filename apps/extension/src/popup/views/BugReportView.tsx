import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bug,
  Camera,
  ChevronDown,
  ChevronUp,
  Globe,
  Terminal,
  Network,
  Send,
  X,
  Loader2,
  CheckCircle,
  Pencil,
} from 'lucide-react';
import { bugReportService } from '../../services/bugReport.service';
import type { BrowserInfo, ConsoleLog, NetworkLog } from '../../services/bugReport.service';
import { Button } from '../../components/ui/Button';
import { InstanceBadge } from '../../components/ui/InstanceBadge';
import { useRecordingStore } from '../../store/recording.store';
import { api } from '../../services/api';
import { cn } from '../../utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BugReportViewProps {
  onCancel: () => void;
  onAnnotate: (screenshotUrl: string) => void;
}

// ─── Section ──────────────────────────────────────────────────────────────────

interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function CollapsibleSection({
  title,
  icon,
  count,
  children,
  defaultOpen = false,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="rounded-2xl border border-white/8 bg-dark-900/60 backdrop-blur-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen((s) => !s)}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-white/4 transition-colors"
      >
        <div className="flex items-center gap-2 text-dark-300">
          <span className="text-indigo-400">{icon}</span>
          <span className="text-xs font-semibold">{title}</span>
          {count !== undefined && (
            <span className="text-xxs bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded-full font-medium">
              {count}
            </span>
          )}
        </div>
        <span className="text-dark-500">
          {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 border-t border-white/6">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Console Log Entry ────────────────────────────────────────────────────────

const CONSOLE_LEVEL_STYLES: Record<string, string> = {
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
  warn: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  info: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  log: 'bg-dark-700 text-dark-400 border-white/10',
  debug: 'bg-dark-700 text-dark-500 border-white/10',
};

function ConsoleLogEntry({ log }: { log: ConsoleLog }) {
  const style = CONSOLE_LEVEL_STYLES[log.level] ?? CONSOLE_LEVEL_STYLES['log'];
  return (
    <div className="flex items-start gap-2 py-1 border-b border-white/4 last:border-0">
      <span
        className={cn(
          'text-xxs px-1.5 py-0.5 rounded-md border font-mono font-semibold shrink-0 mt-0.5',
          style,
        )}
      >
        {log.level.toUpperCase()}
      </span>
      <span className="text-xxs text-dark-300 font-mono break-all line-clamp-2 leading-relaxed">
        {log.args.join(' ')}
      </span>
    </div>
  );
}

// ─── Network Log Entry ────────────────────────────────────────────────────────

function getStatusStyle(status: number, failed?: boolean): string {
  if (failed || status === 0) return 'bg-red-500/20 text-red-400 border-red-500/30';
  if (status >= 500) return 'bg-red-500/20 text-red-400 border-red-500/30';
  if (status >= 400) return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
  if (status >= 200 && status < 300) return 'bg-green-500/20 text-green-400 border-green-500/30';
  return 'bg-dark-700 text-dark-400 border-white/10';
}

function NetworkLogEntry({ log }: { log: NetworkLog }) {
  const statusStyle = getStatusStyle(log.status, log.failed);
  const shortUrl = log.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 40) || log.url.slice(0, 40);

  return (
    <div className="flex items-center gap-2 py-1 border-b border-white/4 last:border-0">
      <span className="text-xxs bg-dark-700 text-dark-400 border border-white/10 px-1.5 py-0.5 rounded-md font-mono font-semibold shrink-0 w-10 text-center">
        {log.method.slice(0, 6)}
      </span>
      <span
        className={cn(
          'text-xxs px-1.5 py-0.5 rounded-md border font-mono font-semibold shrink-0',
          statusStyle,
        )}
      >
        {log.status || 'ERR'}
      </span>
      <span className="text-xxs text-dark-300 font-mono truncate flex-1" title={log.url}>
        {shortUrl}
      </span>
      <span className="text-xxs text-dark-500 shrink-0">{log.duration}ms</span>
    </div>
  );
}

// ─── BugReportView ────────────────────────────────────────────────────────────

export function BugReportView({ onCancel, onAnnotate }: BugReportViewProps) {
  const { annotationScreenshot, setAnnotationScreenshot } = useRecordingStore();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [screenshot, setScreenshot] = useState<string | null>(annotationScreenshot);
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo | null>(null);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [networkLogs, setNetworkLogs] = useState<NetworkLog[]>([]);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  // On mount: load browser info and logs
  useEffect(() => {
    try {
      setBrowserInfo(bugReportService.getBrowserInfo());
    } catch {
      // Extension popup context may differ
    }
    setConsoleLogs(bugReportService.getConsoleLogs(20));
    setNetworkLogs(bugReportService.getNetworkLogs(20));
  }, []);

  // Sync annotationScreenshot from store (set by AnnotationView on save)
  useEffect(() => {
    if (annotationScreenshot) {
      setScreenshot(annotationScreenshot);
      setAnnotationScreenshot(null);
    }
  }, [annotationScreenshot, setAnnotationScreenshot]);

  // Focus title on mount
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const handleCaptureScreenshot = async () => {
    setIsCapturingScreenshot(true);
    setError(null);
    try {
      const dataUrl = await bugReportService.captureScreenshot();
      setScreenshot(dataUrl);
    } catch (err) {
      // In popup context the background screenshot may fail — fallback to captureVisibleTab
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          chrome.tabs.captureVisibleTab({ format: 'png' }, (url) => {
            if (chrome.runtime.lastError || !url) {
              reject(new Error(chrome.runtime.lastError?.message ?? 'Failed'));
            } else {
              resolve(url);
            }
          });
        });
        setScreenshot(dataUrl);
      } catch {
        setError(err instanceof Error ? err.message : 'Screenshot capture failed');
      }
    } finally {
      setIsCapturingScreenshot(false);
    }
  };

  const handleAnnotate = () => {
    if (screenshot) {
      onAnnotate(screenshot);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setTitleError('Title is required');
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    setIsSubmitting(true);
    setError(null);

    try {
      const payload = {
        title: title.trim(),
        description: description.trim(),
        screenshotDataUrl: screenshot,
        annotatedScreenshotDataUrl: null,
        browserInfo: browserInfo as unknown as Record<string, unknown>,
        consoleLogs,
        networkLogs,
      };
      const result = await api.recordings.createBugReport(payload);
      setShareUrl(result.shareUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit bug report');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Success State ──────────────────────────────────────────────────────────

  if (shareUrl) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="h-full flex flex-col items-center justify-center px-6 gap-5"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          className="w-16 h-16 rounded-full bg-green-500/20 border border-green-500/40 flex items-center justify-center"
        >
          <CheckCircle size={32} className="text-green-400" />
        </motion.div>
        <div className="text-center">
          <h2 className="text-lg font-bold text-white">Bug Report Submitted</h2>
          <p className="text-sm text-dark-400 mt-1">Your report has been created successfully</p>
        </div>
        <div className="w-full bg-dark-800/80 border border-white/10 rounded-2xl p-3 flex items-center gap-2">
          <span className="text-xs text-dark-300 font-mono truncate flex-1">{shareUrl}</span>
          <button
            type="button"
            onClick={() => chrome.tabs.create({ url: shareUrl })}
            className="shrink-0 text-xs text-indigo-400 hover:text-indigo-300 font-semibold transition-colors"
          >
            Open
          </button>
        </div>
        <Button variant="secondary" size="md" fullWidth onClick={onCancel}>
          Close
        </Button>
      </motion.div>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center">
            <Bug size={14} className="text-white" />
          </div>
          <h2 className="text-sm font-bold text-white">Report a Bug</h2>
        </div>
        <div className="flex items-center gap-2">
          <InstanceBadge size={14} />
          <button type="button" onClick={onCancel} className="icon-btn" aria-label="Close">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Scrollable Form Body */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
        <form
          onSubmit={(e) => void handleSubmit(e)}
          id="bug-report-form"
          className="flex flex-col gap-3"
        >
          {/* Global Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs"
              >
                <span className="shrink-0 mt-0.5">⚠</span>
                <span>{error}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Title */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="bug-title"
              className="text-xs font-semibold text-dark-300 uppercase tracking-wide"
            >
              Issue Title <span className="text-red-400">*</span>
            </label>
            <input
              ref={titleRef}
              id="bug-title"
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (e.target.value.trim()) setTitleError(null);
              }}
              placeholder="Brief description of the issue..."
              className={cn(
                'w-full h-10 rounded-xl text-sm transition-all duration-200',
                'bg-dark-900/80 text-white placeholder:text-dark-500',
                'border outline-none px-3.5',
                titleError
                  ? 'border-red-500/60 focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
                  : 'border-indigo-500/20 focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/15',
              )}
            />
            {titleError && <p className="text-xs text-red-400">{titleError}</p>}
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="bug-desc"
              className="text-xs font-semibold text-dark-300 uppercase tracking-wide"
            >
              Description
            </label>
            <textarea
              id="bug-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Steps to reproduce, expected vs actual behavior..."
              rows={3}
              className={cn(
                'w-full rounded-xl text-sm transition-all duration-200 resize-none',
                'bg-dark-900/80 text-white placeholder:text-dark-500',
                'border outline-none px-3.5 py-2.5',
                'border-indigo-500/20 focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/15',
              )}
            />
          </div>

          {/* Screenshot */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-dark-300 uppercase tracking-wide">
              Screenshot
            </span>
            {screenshot ? (
              <div className="relative rounded-xl overflow-hidden border border-white/10 group">
                <img
                  src={screenshot}
                  alt="Screenshot preview"
                  className="w-full h-28 object-cover"
                />
                <div className="absolute inset-0 bg-dark-950/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={handleAnnotate}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/80 text-white text-xs font-semibold hover:bg-indigo-500 transition-colors"
                  >
                    <Pencil size={12} />
                    Annotate
                  </button>
                  <button
                    type="button"
                    onClick={() => setScreenshot(null)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/80 text-white text-xs font-semibold hover:bg-red-500 transition-colors"
                  >
                    <X size={12} />
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleCaptureScreenshot()}
                disabled={isCapturingScreenshot}
                className="w-full h-20 rounded-xl border-2 border-dashed border-white/10 hover:border-indigo-500/40 bg-dark-900/40 hover:bg-indigo-500/5 transition-all duration-200 flex flex-col items-center justify-center gap-2 text-dark-400 hover:text-indigo-400"
              >
                {isCapturingScreenshot ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    <span className="text-xs">Capturing...</span>
                  </>
                ) : (
                  <>
                    <Camera size={18} />
                    <span className="text-xs font-medium">Capture Screenshot</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* Browser Info */}
          <CollapsibleSection title="Browser Info" icon={<Globe size={13} />}>
            {browserInfo ? (
              <div className="mt-2 flex flex-col gap-1">
                {[
                  ['Browser', `${browserInfo.browser} ${browserInfo.browserVersion}`],
                  ['OS', `${browserInfo.os} ${browserInfo.osVersion}`],
                  ['Screen', browserInfo.screenResolution],
                  ['Viewport', browserInfo.viewport],
                  ['Language', browserInfo.language],
                  ['Timezone', browserInfo.timezone],
                  ['Cookies', browserInfo.cookiesEnabled ? 'Enabled' : 'Disabled'],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between py-0.5">
                    <span className="text-xxs text-dark-500">{label}</span>
                    <span className="text-xxs text-dark-300 font-mono">{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xxs text-dark-500 mt-2">
                Browser info not available in extension popup
              </p>
            )}
          </CollapsibleSection>

          {/* Console Logs */}
          <CollapsibleSection
            title="Console Logs"
            icon={<Terminal size={13} />}
            count={consoleLogs.length}
          >
            <div className="mt-2 flex flex-col max-h-36 overflow-y-auto scrollbar-thin">
              {consoleLogs.length > 0 ? (
                consoleLogs.map((log, i) => <ConsoleLogEntry key={i} log={log} />)
              ) : (
                <p className="text-xxs text-dark-500 py-2">No console logs captured yet</p>
              )}
            </div>
          </CollapsibleSection>

          {/* Network Logs */}
          <CollapsibleSection
            title="Network Requests"
            icon={<Network size={13} />}
            count={networkLogs.length}
          >
            <div className="mt-2 flex flex-col max-h-36 overflow-y-auto scrollbar-thin">
              {networkLogs.length > 0 ? (
                networkLogs.map((log, i) => <NetworkLogEntry key={i} log={log} />)
              ) : (
                <p className="text-xxs text-dark-500 py-2">No network requests captured yet</p>
              )}
            </div>
          </CollapsibleSection>
        </form>
      </div>

      {/* Footer Actions */}
      <div className="shrink-0 px-4 pb-4 pt-2 flex gap-2 border-t border-white/6">
        <Button type="button" variant="secondary" size="md" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
        <Button
          type="submit"
          form="bug-report-form"
          variant="primary"
          size="md"
          loading={isSubmitting}
          className="flex-1"
          leftIcon={!isSubmitting ? <Send size={14} /> : undefined}
        >
          {isSubmitting ? 'Submitting...' : 'Submit Report'}
        </Button>
      </div>
    </div>
  );
}
