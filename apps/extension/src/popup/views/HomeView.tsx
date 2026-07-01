import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Monitor,
  Camera,
  Settings,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Play,
  FileImage,
  Crop,
  Volume2,
  VolumeX,
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
import { cn } from '@/utils';
import type { RecordingType } from '@/types';

type View =
  | 'home'
  | 'library'
  | 'settings'
  | 'recording'
  | 'upload'
  | 'share'
  | 'login'
  | 'bug-report'
  | 'annotation';

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
  const { settings, toggleMic, toggleWebcam, toggleSystemAudio } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<MainTab>('record');
  const [selectedRecordType, setSelectedRecordType] = useState<RecordingType>('tab');
  const [selectedScreenshotType, setSelectedScreenshotType] = useState<ScreenshotType>('full-page');
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    if (isAuthenticated) void fetchRecordings();
  }, [isAuthenticated, fetchRecordings]);

  const handleStartRecording = async () => {
    setIsStarting(true);
    try {
      // Neither the popup nor the offscreen recorder can surface a mic
      // permission prompt, so if mic is on but not yet granted, send the user
      // to the permission tab and abort this start — they grant once, then
      // start again with the mic working.
      if (settings.micEnabled) {
        const state = await getMicPermissionState();
        if (state === 'prompt' || state === 'denied') {
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

      await startRecording({
        type: selectedRecordType,
        quality: settings.recordingQuality,
        micEnabled: settings.micEnabled,
        webcamOverlay: settings.webcamOverlay,
        systemAudio: settings.systemAudio,
        tabId: activeTab?.id,
      });
      // Close the popup so the floating toolbar (injected into the page) takes over
      window.close();
    } catch (err) {
      console.error('Failed to start recording:', err);
      setIsStarting(false);
    }
  };

  const handleScreenshot = async () => {
    // Await so the tab query inside completes before the popup closes.
    // The popup must still be open when chrome.tabs.query({currentWindow:true}) runs
    // so it resolves to the page tab, not the popup's own window.
    await takeScreenshot(selectedScreenshotType);
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

        <button
          onClick={() => onNavigate('settings')}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all"
        >
          <Settings size={15} />
        </button>
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

      {/* ─── Scrollable Body ─── */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-none">
        <AnimatePresence mode="wait">
          {activeTab === 'record' ? (
            <motion.div
              key="record"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
              className="px-4 pb-4 flex flex-col gap-4"
            >
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
                  icon={settings.webcamOverlay ? <Video size={12} /> : <VideoOff size={12} />}
                  label="Cam"
                  active={settings.webcamOverlay}
                  onClick={() => void toggleWebcam()}
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
            </motion.div>
          ) : (
            <motion.div
              key="screenshot"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
              className="px-4 pb-4 flex flex-col gap-4"
            >
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
            </motion.div>
          )}
        </AnimatePresence>
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
                <span className="text-[10px] text-jam-400 font-medium">Pro Plan</span>
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
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-2 px-2 py-3.5 rounded-2xl border text-center transition-all duration-200',
        selected
          ? 'bg-jam-500/12 border-jam-500/40'
          : 'bg-dark-900/70 border-white/8 hover:bg-dark-800/80 hover:border-white/14',
      )}
    >
      <div
        className={cn(
          'w-8 h-8 rounded-xl flex items-center justify-center',
          selected ? 'bg-jam-500/25 text-jam-300' : 'bg-dark-800 text-dark-400',
        )}
      >
        {icon}
      </div>
      <div>
        <p
          className={cn(
            'text-[11px] font-semibold leading-tight',
            selected ? 'text-white' : 'text-dark-300',
          )}
        >
          {title}
        </p>
        <p className="text-[10px] text-dark-600 mt-0.5 leading-snug">{description}</p>
      </div>
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
