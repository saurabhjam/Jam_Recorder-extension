import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Monitor,
  Camera,
  Settings,
  Mic,
  MicOff,
  Play,
  FileImage,
  Crop,
  Volume2,
  VolumeX,
  Gauge,
  ChevronDown,
  Check,
  AlertTriangle,
  X,
  Bug,
  Upload,
  Library,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { useRecordingStore } from '@/store/recording.store';
import {
  useSettingsStore,
  getMicPermissionState,
  openMicPermissionPage,
} from '@/store/settings.store';
import { Avatar } from '@/components/ui/Avatar';
import { InstanceBadge } from '@/components/ui/InstanceBadge';
import { cn, isRestrictedUrl, generateId } from '@/utils';
import type { RecordingType, RecordingQuality } from '@/types';
import { STORAGE_KEYS } from '@/types';

// Shared local blob store (same DB the editor reads recordings from) so an
// uploaded video can be handed off to the editor by id.
const IDB_NAME = 'bestq-blobs';
const IDB_STORE = 'recordings';
function saveBlobToIDB(id: string, blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Show the on-page 3…2…1 countdown on a tab and wait for it to finish before
 *  the recording starts. Injects the content script if it isn't already there;
 *  silently skips (no wait) if the page can't host it. */
async function runCountdownOnTab(tabId: number, seconds: number): Promise<void> {
  const send = () =>
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_COUNTDOWN', payload: { seconds } });
  try {
    await send();
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/index.js'] });
      await new Promise((r) => setTimeout(r, 100));
      await send();
    } catch {
      return; // couldn't show the countdown — start immediately
    }
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

type View =
  | 'home'
  | 'library'
  | 'settings'
  | 'recording'
  | 'upload'
  | 'login'
  | 'bug-report'
  | 'annotation'
  | 'monitoring';

type MainTab = 'record' | 'screenshot';
type ScreenshotType = 'full-page' | 'area' | 'visible';

interface HomeViewProps {
  onNavigate: (view: View) => void;
}

// ─── Tab icon: Chrome tab SVG (matches the image) ──────────────────────────────
function TabIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <rect x="1" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1 8h16" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="5.5" width="5" height="2.5" rx="1" fill="currentColor" />
    </svg>
  );
}

const RECORD_OPTIONS: Array<{
  type: RecordingType;
  icon: React.ReactNode;
  title: string;
  description: string;
}> = [
  {
    type: 'tab',
    icon: <TabIcon size={18} />,
    title: 'Record Tab',
    description: 'Capture only current tab',
  },
  {
    type: 'screen',
    icon: <Monitor size={18} />,
    title: 'Record Desktop',
    description: 'Capture entire screen, window or any tab',
  },
];

// Resolution options for the recording quality dropdown. Lower resolution =
// smaller file; each maps to a preset in QUALITY_PRESETS (frame rate + bitrate).
const QUALITY_OPTIONS: Array<{ value: RecordingQuality; label: string; hint: string }> = [
  { value: '480p', label: '480p', hint: 'Smallest · ~80 MB/hr' },
  { value: '720p', label: '720p', hint: 'Recommended · ~150 MB/hr' },
  { value: '1080p', label: '1080p', hint: 'Best clarity · ~280 MB/hr' },
];

const SCREENSHOT_OPTIONS: Array<{
  type: ScreenshotType;
  icon: React.ReactNode;
  title: string;
  description: string;
}> = [
  {
    type: 'full-page',
    icon: <FileImage size={16} />,
    title: 'Full Page',
    description: 'Capture entire page',
  },
  {
    type: 'area',
    icon: <Crop size={16} />,
    title: 'Selected Area',
    description: 'Select any area',
  },
  {
    type: 'visible',
    icon: <Monitor size={16} />,
    title: 'Visible Screen',
    description: 'Capture visible area',
  },
];

export function HomeView({ onNavigate }: HomeViewProps) {
  const { user, logout, isAuthenticated } = useAuthStore();
  const { startRecording, takeScreenshot, fetchRecordings } = useRecordingStore();
  const { settings, toggleMic, toggleSystemAudio, setQuality, updateSettings } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<MainTab>('record');
  const [selectedRecordType, setSelectedRecordType] = useState<RecordingType>('tab');
  const [selectedScreenshotType, setSelectedScreenshotType] = useState<ScreenshotType>('full-page');
  const [isStarting, setIsStarting] = useState(false);
  // Recording/screenshots can't run on chrome:// pages, the Web Store, etc. When
  // the current tab is one of those we block the action and show a notice popup.
  const [isRestrictedPage, setIsRestrictedPage] = useState(false);
  const [showUnsupported, setShowUnsupported] = useState(false);
  // Uploading a local video → hands it to the editor (same save/upload flow).
  const [isPreparingUpload, setIsPreparingUpload] = useState(false);
  const videoUploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAuthenticated) void fetchRecordings();
  }, [isAuthenticated, fetchRecordings]);

  // Detect whether the current tab is a page the extension can't operate on.
  useEffect(() => {
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setIsRestrictedPage(isRestrictedUrl(tab?.url));
      } catch {
        setIsRestrictedPage(false);
      }
    })();
  }, []);

  const handleStartRecording = async () => {
    if (isRestrictedPage) {
      setShowUnsupported(true);
      return;
    }
    setIsStarting(true);
    try {
      // Neither the popup nor the offscreen recorder can surface a mic
      // permission prompt, so if mic is on but not yet granted, send the user
      // to the permission tab and abort this start — they grant once, then
      // start again with the mic working.
      //
      // IMPORTANT: `navigator.permissions.query` is unreliable in the action
      // popup — it can keep reporting 'prompt' even after the user has granted
      // mic access on the permission page, which trapped users in an endless
      // loop back to that page. So we treat a previously recorded grant
      // (settings.micPermissionGranted, written by the permission page when its
      // getUserMedia actually succeeds) as authoritative. Only redirect when we
      // have neither a live 'granted' state nor a stored grant. The offscreen
      // recorder already falls back to no-mic if access is somehow missing, so
      // this can never block a recording.
      if (settings.micEnabled && !settings.micPermissionGranted) {
        const state = await getMicPermissionState();
        if (state !== 'granted') {
          await openMicPermissionPage();
          setIsStarting(false);
          return;
        }
      }

      // Resolve the active tab while the popup is still frontmost. Both tab and
      // screen recordings need it: 'tab' captures this tab, and 'screen'/window
      // shares tab-capture its audio as a fallback (macOS can't provide system
      // audio for screen/window). The service worker can't resolve it reliably
      // (currentWindow:true has no window context there).
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Optional pre-recording countdown (3…2…1) shown on the page.
      if (settings.countdownEnabled && activeTab?.id && !isRestrictedPage) {
        await runCountdownOnTab(activeTab.id, settings.countdownSeconds || 3);
      }

      await startRecording({
        type: selectedRecordType,
        quality: settings.recordingQuality,
        micEnabled: settings.micEnabled,
        webcamOverlay: settings.webcamOverlay,
        systemAudio: settings.systemAudio,
        captureDevtools: settings.captureDevtools,
        tabId: activeTab?.id,
      });
      // Close the popup so the floating toolbar (injected into the page) takes over
      window.close();
    } catch (err) {
      console.error('Failed to start recording:', err);
      setIsStarting(false);
    }
  };

  // Upload a local video: store it in the shared blob DB, then open the editor
  // pointed at it so it goes through the exact same project-select → save →
  // upload flow as a recording (same portal/DB API).
  const handleVideoFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    setIsPreparingUpload(true);
    try {
      const id = generateId();
      await saveBlobToIDB(id, file);
      await chrome.storage.local.set({
        [STORAGE_KEYS.EDITOR_DATA]: {
          recordingId: id,
          thumbnailDataUrl: null,
          duration: 0,
          blobSize: file.size,
          title: file.name.replace(/\.[^./\\]+$/, ''),
          recordingType: 'tab',
          consoleLogs: [],
          networkCaptures: [],
        },
      });
      await chrome.windows.create({
        url: chrome.runtime.getURL(`src/editor/index.html?recordingId=${id}`),
        type: 'popup',
        width: 1400,
        height: 900,
        focused: true,
      });
      window.close();
    } catch (err) {
      console.error('Failed to prepare uploaded video:', err);
      setIsPreparingUpload(false);
    }
  };

  const handleScreenshot = async () => {
    // Restricted pages (chrome://, Web Store) can't host our content script, so
    // full-page/area capture and the in-page preview won't work there. We still
    // allow a plain visible-area screenshot — the background captures it and
    // downloads the image as a fallback when it can't show the preview.
    const type = isRestrictedPage ? 'visible' : selectedScreenshotType;
    // Await so the tab query inside completes before the popup closes.
    // The popup must still be open when chrome.tabs.query({currentWindow:true}) runs
    // so it resolves to the page tab, not the popup's own window.
    await takeScreenshot(type);
    window.close();
  };

  return (
    <div className="h-full flex flex-col bg-dark-950 overflow-hidden">
      {/* ─── Header ─── */}
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="flex items-center justify-between px-4 pt-3.5 pb-3 shrink-0"
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 overflow-hidden">
            <img
              src={chrome.runtime.getURL('icons/bestq-logo.png')}
              alt="BestQ"
              className="w-full h-full object-contain"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-white tracking-tight">BestQ</span>
            <span className="text-[10px] font-semibold bg-jam-500/20 text-jam-300 border border-jam-500/30 px-1.5 py-0.5 rounded-md leading-none">
              v1
            </span>
            <InstanceBadge size={13} />
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Screen monitoring is a separate product from recording, so it gets
              its own entry rather than being folded into the record tabs. */}
          <button
            onClick={() => onNavigate('monitoring')}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all"
            title="Screen Monitoring"
          >
            <Monitor size={15} />
          </button>
          <button
            onClick={() => onNavigate('library')}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all"
            title="My Recordings & Drafts"
          >
            <Library size={15} />
          </button>
          <button
            onClick={() => onNavigate('settings')}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all"
          >
            <Settings size={15} />
          </button>
        </div>
      </motion.div>

      {/* ─── Tab Bar ─── */}
      <div className="px-4 pb-3 shrink-0">
        <div className="flex gap-0.5 bg-dark-900 border border-white/6 rounded-xl p-1">
          <TabPill
            active={activeTab === 'record'}
            label="Recording"
            onClick={() => setActiveTab('record')}
          />
          <TabPill
            active={activeTab === 'screenshot'}
            label="Screenshot"
            onClick={() => setActiveTab('screenshot')}
          />
        </div>
      </div>

      {/* ─── Unsupported page banner ─── */}
      {isRestrictedPage && (
        <div className="px-4 pb-3 shrink-0">
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25">
            <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-snug text-amber-200/90">
              BestQ can't record or capture on this page. Open a normal website (http/https) and try
              again.
            </p>
          </div>
        </div>
      )}

      {/* ─── Scrollable Body ─── */}
      {/* A single panel keyed by activeTab (remounts + fades on switch). Using two
          keyed siblings inside AnimatePresence mode="wait" could deadlock — a state
          change mid-exit left the incoming panel stuck/blank. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-none">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="px-4 pb-4 flex flex-col gap-4"
        >
          {activeTab === 'record' ? (
            <>
              {/* Title */}
              <div className="pt-1">
                <h2 className="text-base font-bold text-white leading-tight">Record something</h2>
                <p className="text-xs text-dark-400 mt-0.5">
                  Capture bugs, flows and issues with logs.
                </p>
              </div>

              {/* Record type cards */}
              <div className="flex flex-col gap-2">
                {RECORD_OPTIONS.map((opt) => (
                  <RecordCard
                    key={opt.type}
                    icon={opt.icon}
                    title={opt.title}
                    description={opt.description}
                    selected={selectedRecordType === opt.type}
                    onClick={() => setSelectedRecordType(opt.type)}
                  />
                ))}
              </div>

              {/* Quality (resolution) selector — lower = smaller file */}
              <QualitySelect
                value={settings.recordingQuality}
                onChange={(q) => void setQuality(q)}
              />

              {/* Controls */}
              <div className="flex items-center gap-2">
                <ControlToggle
                  icon={settings.micEnabled ? <Mic size={12} /> : <MicOff size={12} />}
                  label="Mic"
                  active={settings.micEnabled}
                  onClick={() => void toggleMic()}
                />
                <ControlToggle
                  icon={settings.systemAudio ? <Volume2 size={12} /> : <VolumeX size={12} />}
                  label="Audio"
                  active={settings.systemAudio}
                  onClick={() => void toggleSystemAudio()}
                />
                <ControlToggle
                  icon={<Bug size={12} />}
                  label="Logs"
                  active={settings.captureDevtools}
                  onClick={() =>
                    void updateSettings({ captureDevtools: !settings.captureDevtools })
                  }
                />
              </div>

              {/* Start Recording CTA */}
              <motion.button
                whileTap={{ scale: 0.97 }}
                whileHover={{ y: -1 }}
                disabled={isStarting}
                onClick={() => void handleStartRecording()}
                className={cn(
                  'w-full h-12 rounded-2xl flex items-center justify-center gap-2.5 relative overflow-hidden',
                  'bg-gradient-to-r from-jam-500 to-violet-500',
                  'hover:from-jam-600 hover:to-violet-600',
                  'text-white font-semibold text-sm shadow-jam',
                  'transition-all duration-200',
                  'disabled:opacity-60 disabled:cursor-not-allowed',
                )}
              >
                <motion.div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
                  animate={{ x: ['-100%', '100%'] }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
                />
                <span className="relative flex items-center gap-2.5">
                  {isStarting ? (
                    <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  ) : (
                    <>
                      <span className="w-2 h-2 rounded-full bg-white/90 animate-recording-pulse" />
                      <Play size={14} className="fill-white" />
                    </>
                  )}
                  <span>{isStarting ? 'Starting…' : 'Start Recording'}</span>
                </span>
              </motion.button>

              {/* Divider */}
              <div className="flex items-center gap-2">
                <div className="flex-1 h-px bg-white/8" />
                <span className="text-[10px] text-dark-500 font-semibold tracking-wide">OR</span>
                <div className="flex-1 h-px bg-white/8" />
              </div>

              {/* Upload an existing local video → opens the editor to save it */}
              <input
                ref={videoUploadInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => void handleVideoFileSelected(e)}
              />
              <motion.button
                whileTap={{ scale: 0.98 }}
                whileHover={{ y: -1 }}
                disabled={isPreparingUpload}
                onClick={() => videoUploadInputRef.current?.click()}
                className={cn(
                  'w-full h-11 rounded-2xl flex items-center justify-center gap-2',
                  'border border-white/10 bg-dark-900/70 hover:bg-dark-800/80 hover:border-white/16',
                  'text-dark-200 font-semibold text-sm transition-all duration-200',
                  'disabled:opacity-60 disabled:cursor-not-allowed',
                )}
              >
                {isPreparingUpload ? (
                  <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                ) : (
                  <Upload size={15} className="text-jam-300" />
                )}
                <span>{isPreparingUpload ? 'Opening editor…' : 'Upload a video'}</span>
              </motion.button>
            </>
          ) : (
            <>
              {/* Title */}
              <div className="pt-1">
                <h2 className="text-base font-bold text-white leading-tight">Take a screenshot</h2>
                <p className="text-xs text-dark-400 mt-0.5">Capture your screen instantly.</p>
              </div>

              {/* Screenshot type cards */}
              <div className="grid grid-cols-3 gap-2">
                {SCREENSHOT_OPTIONS.map((opt) => (
                  <ScreenshotCard
                    key={opt.type}
                    icon={opt.icon}
                    title={opt.title}
                    description={opt.description}
                    selected={selectedScreenshotType === opt.type}
                    onClick={() => setSelectedScreenshotType(opt.type)}
                  />
                ))}
              </div>

              {/* Take Screenshot CTA */}
              <motion.button
                whileTap={{ scale: 0.97 }}
                whileHover={{ y: -1 }}
                onClick={() => void handleScreenshot()}
                className="w-full h-12 rounded-2xl flex items-center justify-center gap-2.5 relative overflow-hidden bg-gradient-to-r from-jam-500 to-violet-500 hover:from-jam-600 hover:to-violet-600 text-white font-semibold text-sm shadow-jam transition-all duration-200"
              >
                <motion.div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
                  animate={{ x: ['-100%', '100%'] }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
                />
                <span className="relative flex items-center gap-2.5">
                  <Camera size={15} />
                  <span>Take Screenshot</span>
                </span>
              </motion.button>
            </>
          )}
        </motion.div>
      </div>

      {/* ─── User Footer ─── */}
      {user && (
        <div className="shrink-0 border-t border-white/6 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Avatar src={user.avatar ?? undefined} name={user.name} size="sm" />
              <div>
                <p className="text-xs font-semibold text-white leading-tight">
                  {user.name
                    .split(' ')
                    .slice(0, 2)
                    .join(' ')
                    .replace(/ (\w+)$/, ' $1')
                    .slice(0, 14)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => onNavigate('settings')}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all"
                title="Settings"
              >
                <Settings size={14} />
              </button>
              <button
                onClick={() => void logout()}
                className="text-[10px] text-dark-500 hover:text-red-400 transition-colors px-1"
                title="Sign out"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Unsupported page popup ─── */}
      <AnimatePresence>
        {showUnsupported && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-dark-950/70 backdrop-blur-sm px-6"
            onClick={() => setShowUnsupported(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 8 }}
              transition={{ type: 'spring', stiffness: 340, damping: 26 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-[300px] rounded-2xl bg-dark-900 border border-white/10 shadow-2xl p-5 text-center"
            >
              <button
                onClick={() => setShowUnsupported(false)}
                className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-lg text-dark-500 hover:text-white hover:bg-white/8 transition-all"
              >
                <X size={15} />
              </button>

              <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                <AlertTriangle size={22} className="text-amber-400" />
              </div>

              <h3 className="text-sm font-bold text-white mt-3.5">This page isn't supported</h3>
              <p className="text-xs text-dark-400 mt-1.5 leading-relaxed">
                BestQ can't record or take screenshots on browser pages like the Chrome Web Store or{' '}
                <span className="text-dark-300">chrome://</span> settings. Switch to a regular
                website and try again.
              </p>

              <button
                onClick={() => setShowUnsupported(false)}
                className="w-full h-10 mt-4 rounded-xl bg-gradient-to-r from-jam-500 to-violet-500 hover:from-jam-600 hover:to-violet-600 text-white font-semibold text-sm transition-all"
              >
                Got it
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Tab Pill ─────────────────────────────────────────────────────────────────

function TabPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 h-8 rounded-lg text-xs font-semibold transition-all duration-200',
        active
          ? 'bg-jam-500/25 text-jam-200 border border-jam-500/35 shadow-sm'
          : 'text-dark-400 hover:text-dark-200',
      )}
    >
      {label}
    </button>
  );
}

// ─── Record Card (large, horizontal) ─────────────────────────────────────────

interface RecordCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}

function RecordCard({ icon, title, description, selected, onClick }: RecordCardProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.985 }}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl border text-left transition-all duration-200',
        selected
          ? 'bg-jam-500/12 border-jam-500/40 shadow-[0_0_0_1px_rgba(139,92,246,0.2)]'
          : 'bg-dark-900/70 border-white/8 hover:bg-dark-800/80 hover:border-white/14',
      )}
    >
      {/* Icon box */}
      <div
        className={cn(
          'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200',
          selected
            ? 'bg-jam-500/25 text-jam-300'
            : 'bg-dark-800 text-dark-400 group-hover:text-dark-200',
        )}
      >
        {icon}
      </div>

      {/* Text */}
      <div>
        <p
          className={cn(
            'text-sm font-semibold leading-tight',
            selected ? 'text-white' : 'text-dark-200',
          )}
        >
          {title}
        </p>
        <p className="text-xs text-dark-500 mt-0.5 leading-snug">{description}</p>
      </div>

      {/* Selected dot */}
      <div className="ml-auto shrink-0">
        <div
          className={cn(
            'w-4 h-4 rounded-full border-2 transition-all duration-200 flex items-center justify-center',
            selected ? 'border-jam-400 bg-jam-500' : 'border-dark-600 bg-transparent',
          )}
        >
          {selected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
        </div>
      </div>
    </motion.button>
  );
}

// ─── Screenshot Card (small, vertical) ───────────────────────────────────────

interface ScreenshotCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}

function ScreenshotCard({ icon, title, description, selected, onClick }: ScreenshotCardProps) {
  return (
    <motion.button
      type="button"
      aria-pressed={selected}
      whileTap={{ scale: 0.95 }}
      whileHover={{ y: -2 }}
      onClick={onClick}
      className={cn(
        'group relative flex flex-col items-center gap-2 px-2 py-3.5 rounded-2xl border text-center overflow-hidden transition-colors duration-200',
        selected
          ? 'border-jam-400/70 shadow-[0_0_0_1px_rgba(124,58,237,0.45),0_10px_28px_-8px_rgba(124,58,237,0.65)]'
          : 'border-white/8 bg-dark-900/70 hover:bg-dark-800/80 hover:border-white/16',
      )}
    >
      {/* Sliding highlight — a single shared element that glides to whichever
          card is selected (framer "magic move"), so the active choice is
          unmistakable and the transition feels alive. */}
      {selected && (
        <motion.span
          layoutId="screenshot-card-highlight"
          transition={{ type: 'spring', stiffness: 500, damping: 34 }}
          className="absolute inset-0 rounded-2xl bg-gradient-to-b from-jam-500/30 to-violet-500/10"
        />
      )}

      {/* Check badge confirming the selection */}
      <AnimatePresence>
        {selected && (
          <motion.span
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 600, damping: 22 }}
            className="absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full bg-jam-500 flex items-center justify-center shadow-md"
          >
            <Check size={10} strokeWidth={3.5} className="text-white" />
          </motion.span>
        )}
      </AnimatePresence>

      <motion.span
        animate={selected ? { scale: 1.06 } : { scale: 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 18 }}
        className={cn(
          'relative z-10 w-9 h-9 rounded-xl flex items-center justify-center transition-colors duration-200',
          selected
            ? 'bg-jam-500 text-white shadow-jam'
            : 'bg-dark-800 text-dark-400 group-hover:text-dark-200',
        )}
      >
        {icon}
      </motion.span>
      <span className="relative z-10 block">
        <span
          className={cn(
            'block text-[11px] font-semibold leading-tight transition-colors duration-200',
            selected ? 'text-white' : 'text-dark-300',
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            'block text-[10px] mt-0.5 leading-snug transition-colors duration-200',
            selected ? 'text-jam-200/90' : 'text-dark-600',
          )}
        >
          {description}
        </span>
      </span>
    </motion.button>
  );
}

// ─── Control Toggle ───────────────────────────────────────────────────────────

function ControlToggle({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all duration-200',
        active
          ? 'bg-jam-500/15 text-jam-300 border-jam-500/30'
          : 'bg-dark-800/70 text-dark-400 border-white/8 hover:text-dark-200 hover:border-white/14',
      )}
    >
      {icon}
      <span>{label}</span>
      <span className={cn('text-[10px] font-semibold', active ? 'text-jam-400' : 'text-dark-600')}>
        {active ? 'ON' : 'OFF'}
      </span>
    </motion.button>
  );
}

// ─── Quality (resolution) Dropdown ────────────────────────────────────────────

function QualitySelect({
  value,
  onChange,
}: {
  value: RecordingQuality;
  onChange: (q: RecordingQuality) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = QUALITY_OPTIONS.find((o) => o.value === value) ?? QUALITY_OPTIONS[1];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all duration-200',
          open
            ? 'bg-dark-800/80 border-jam-500/40'
            : 'bg-dark-900/70 border-white/8 hover:bg-dark-800/80 hover:border-white/14',
        )}
      >
        <Gauge size={13} className="text-jam-300 shrink-0" />
        <span className="text-xs font-medium text-dark-300">Quality</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-dark-500">{current.hint}</span>
          <span className="text-xs font-semibold text-white">{current.label}</span>
          <ChevronDown
            size={13}
            className={cn('text-dark-400 transition-transform duration-200', open && 'rotate-180')}
          />
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Click-outside catcher */}
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              className="absolute left-0 right-0 mt-1.5 z-20 rounded-xl border border-white/10 bg-dark-900 shadow-xl overflow-hidden"
            >
              {QUALITY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors',
                    o.value === value ? 'bg-jam-500/15' : 'hover:bg-white/5',
                  )}
                >
                  <span
                    className={cn(
                      'text-xs font-semibold w-11 shrink-0',
                      o.value === value ? 'text-jam-200' : 'text-dark-200',
                    )}
                  >
                    {o.label}
                  </span>
                  <span className="text-[10px] text-dark-500">{o.hint}</span>
                  {o.value === value && (
                    <Check size={13} className="ml-auto text-jam-400 shrink-0" />
                  )}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
