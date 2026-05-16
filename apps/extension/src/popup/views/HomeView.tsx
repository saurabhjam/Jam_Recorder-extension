import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Monitor,
  Chrome,
  AppWindow,
  Camera,
  FileImage,
  Crop,
  Settings,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Play,
  ChevronDown,
  MoreHorizontal,
  Cloud,
  CloudOff,
  LogOut,
  ChevronRight,
  Timer,
  MousePointer,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { useRecordingStore } from '@/store/recording.store';
import { useSettingsStore } from '@/store/settings.store';
import { RecordingTypeCard } from '@/components/RecordingTypeCard';
import { Avatar } from '@/components/ui/Avatar';
import { formatRelativeDate, formatDuration, cn } from '@/utils';
import type { Recording, RecordingType } from '@/types';

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
type ScreenshotType = 'full-page' | 'area' | 'full-screen';
type ScreenshotDelay = 'none' | '3s' | '5s';
type ScreenshotFormat = 'PNG' | 'JPG' | 'WEBP';

interface HomeViewProps {
  onNavigate: (view: View) => void;
}

const CONTAINER_VARIANTS = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0.08 },
  },
};

const ITEM_VARIANTS = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 380, damping: 26 } },
};

const RECORD_TYPES: Array<{
  type: RecordingType;
  icon: React.ReactNode;
  title: string;
  description: string;
}> = [
  {
    type: 'screen',
    icon: <Monitor size={18} />,
    title: 'Full Screen',
    description: 'Entire screen',
  },
  { type: 'tab', icon: <Chrome size={18} />, title: 'Tab', description: 'Current tab' },
  { type: 'screen', icon: <AppWindow size={18} />, title: 'Window', description: 'Choose window' },
];

const SCREENSHOT_TYPES: Array<{
  type: ScreenshotType;
  icon: React.ReactNode;
  title: string;
  description: string;
}> = [
  {
    type: 'full-page',
    icon: <FileImage size={18} />,
    title: 'Full Page',
    description: 'Entire page',
  },
  { type: 'area', icon: <Crop size={18} />, title: 'Selected Area', description: 'Choose area' },
  {
    type: 'full-screen',
    icon: <Monitor size={18} />,
    title: 'Full Screen',
    description: 'Your screen',
  },
];

export function HomeView({ onNavigate }: HomeViewProps) {
  const { user, logout, isAuthenticated } = useAuthStore();
  const { recordings, startRecording, takeScreenshot, fetchRecordings } = useRecordingStore();
  const { settings, toggleMic, toggleWebcam, setQuality } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<MainTab>('record');
  const [selectedRecordIndex, setSelectedRecordIndex] = useState(0);
  const [selectedScreenshotType, setSelectedScreenshotType] = useState<ScreenshotType>('full-page');
  const [isStarting, setIsStarting] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [fpsMenuOpen, setFpsMenuOpen] = useState(false);
  const [delayMenuOpen, setDelayMenuOpen] = useState(false);
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [screenshotDelay, setScreenshotDelay] = useState<ScreenshotDelay>('none');
  const [includeCursor, setIncludeCursor] = useState(true);
  const [screenshotFormat, setScreenshotFormat] = useState<ScreenshotFormat>('PNG');
  const [isOnline] = useState(navigator.onLine);

  const recentRecordings = recordings.slice(0, 4);

  // Only fetch recordings when the user is actually authenticated
  useEffect(() => {
    if (isAuthenticated) {
      void fetchRecordings();
    }
  }, [isAuthenticated, fetchRecordings]);

  // Close menus when clicking outside
  useEffect(() => {
    const close = () => {
      setUserMenuOpen(false);
      setQualityMenuOpen(false);
      setFpsMenuOpen(false);
      setDelayMenuOpen(false);
      setFormatMenuOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const selectedRecordType = RECORD_TYPES[selectedRecordIndex];

  const handleStartRecording = async () => {
    if (!selectedRecordType) return;
    setIsStarting(true);
    try {
      await startRecording({
        type: selectedRecordType.type,
        quality: settings.recordingQuality,
        micEnabled: settings.micEnabled,
        webcamOverlay: settings.webcamOverlay,
        systemAudio: settings.systemAudio,
      });
    } catch (err) {
      console.error('Failed to start recording:', err);
    } finally {
      setIsStarting(false);
    }
  };

  const handleScreenshot = async () => {
    try {
      await takeScreenshot();
    } catch (err) {
      console.error('Failed to take screenshot:', err);
    }
  };

  const fpsValue =
    settings.recordingQuality === 'high' || settings.recordingQuality === '4k' ? '60' : '30';

  const qualityLabel =
    settings.recordingQuality === '4k'
      ? '4K'
      : settings.recordingQuality === 'high'
        ? '1080p'
        : settings.recordingQuality === 'medium'
          ? '720p'
          : '480p';

  const storageUsedGB = 2.4;
  const storageTotalGB = 10;
  const storagePercent = (storageUsedGB / storageTotalGB) * 100;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-dark-950">
      {/* ─── Header ─── */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex items-center justify-between px-4 pt-3.5 pb-2.5 shrink-0"
      >
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-jam-500 via-jam-400 to-violet-400 flex items-center justify-center shadow-jam shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 2L14 8L8 14L2 8L8 2Z" fill="white" fillOpacity="0.95" />
              <circle cx="8" cy="8" r="2.5" fill="white" />
            </svg>
          </div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-sm font-bold text-white tracking-tight">SnapTrace</h1>
            <span className="text-xxs font-semibold bg-jam-500/25 text-jam-300 border border-jam-500/30 px-1.5 py-0.5 rounded-md">
              v1
            </span>
          </div>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onNavigate('settings')}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all"
            title="Settings"
          >
            <Settings size={15} />
          </button>

          {/* User avatar + dropdown */}
          {user && (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setUserMenuOpen((v) => !v);
                }}
                className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 hover:bg-white/6 transition-colors"
              >
                <Avatar src={user.avatar ?? undefined} name={user.name} size="xs" />
                <ChevronDown size={11} className="text-dark-400" />
              </button>

              <AnimatePresence>
                {userMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.96 }}
                    transition={{ duration: 0.15 }}
                    className="absolute right-0 top-full mt-1 w-44 glass-card rounded-xl py-1.5 z-50"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="px-3 py-2 border-b border-white/6">
                      <p className="text-xs font-semibold text-white truncate">{user.name}</p>
                      <p className="text-xxs text-dark-400 truncate">{user.email}</p>
                    </div>
                    <button
                      onClick={() => {
                        setUserMenuOpen(false);
                        onNavigate('settings');
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-dark-300 hover:text-white hover:bg-white/6 transition-colors"
                    >
                      <Settings size={12} />
                      Settings
                    </button>
                    <button
                      onClick={() => void logout()}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-dark-300 hover:text-red-400 hover:bg-red-500/8 transition-colors"
                    >
                      <LogOut size={12} />
                      Sign out
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </motion.div>

      {/* ─── Tab Bar ─── */}
      <div className="px-4 pb-2.5 shrink-0">
        <div className="flex gap-0.5 bg-dark-900/60 border border-white/6 rounded-xl p-0.5">
          <TabButton
            active={activeTab === 'record'}
            onClick={() => setActiveTab('record')}
            icon={<Video size={13} />}
            label="Record"
          />
          <TabButton
            active={activeTab === 'screenshot'}
            onClick={() => setActiveTab('screenshot')}
            icon={<Camera size={13} />}
            label="Screenshot"
          />
        </div>
      </div>

      {/* ─── Scrollable Content ─── */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
        <AnimatePresence mode="wait">
          {activeTab === 'record' ? (
            <motion.div
              key="record-tab"
              variants={CONTAINER_VARIANTS}
              initial="hidden"
              animate="show"
              exit={{ opacity: 0 }}
              className="flex flex-col gap-3.5 px-4 pb-4"
            >
              {/* Recording Options */}
              <motion.div variants={ITEM_VARIANTS}>
                <p className="text-xxs font-semibold text-dark-500 uppercase tracking-widest mb-2">
                  Recording Options
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {RECORD_TYPES.map(({ icon, title, description }, idx) => (
                    <RecordingTypeCard
                      key={`${title}-${idx}`}
                      icon={icon}
                      title={title}
                      description={description}
                      selected={selectedRecordIndex === idx}
                      onClick={() => setSelectedRecordIndex(idx)}
                    />
                  ))}
                </div>
              </motion.div>

              {/* Controls Row */}
              <motion.div variants={ITEM_VARIANTS}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Mic toggle */}
                  <ToggleControl
                    icon={settings.micEnabled ? <Mic size={12} /> : <MicOff size={12} />}
                    label="Mic"
                    value={settings.micEnabled ? 'On' : 'Off'}
                    active={settings.micEnabled}
                    onClick={() => void toggleMic()}
                  />

                  {/* Camera toggle */}
                  <ToggleControl
                    icon={settings.webcamOverlay ? <Video size={12} /> : <VideoOff size={12} />}
                    label="Camera"
                    value={settings.webcamOverlay ? 'On' : 'Off'}
                    active={settings.webcamOverlay}
                    onClick={() => void toggleWebcam()}
                  />

                  {/* Quality dropdown */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setQualityMenuOpen((v) => !v);
                      }}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-dark-800/70 border border-white/8 text-xxs font-medium text-dark-300 hover:text-white hover:border-white/16 transition-all"
                    >
                      <Monitor size={11} />
                      <span>{qualityLabel}</span>
                      <ChevronDown size={10} />
                    </button>
                    <AnimatePresence>
                      {qualityMenuOpen && (
                        <DropdownMenu onClose={() => setQualityMenuOpen(false)}>
                          {(['low', 'medium', 'high', '4k'] as const).map((q) => (
                            <DropdownItem
                              key={q}
                              label={
                                q === '4k'
                                  ? '4K'
                                  : q === 'high'
                                    ? '1080p'
                                    : q === 'medium'
                                      ? '720p'
                                      : '480p'
                              }
                              active={settings.recordingQuality === q}
                              onClick={() => {
                                void setQuality(q);
                                setQualityMenuOpen(false);
                              }}
                            />
                          ))}
                        </DropdownMenu>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* FPS dropdown */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setFpsMenuOpen((v) => !v);
                      }}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-dark-800/70 border border-white/8 text-xxs font-medium text-dark-300 hover:text-white hover:border-white/16 transition-all"
                    >
                      <span>{fpsValue} fps</span>
                      <ChevronDown size={10} />
                    </button>
                    <AnimatePresence>
                      {fpsMenuOpen && (
                        <DropdownMenu onClose={() => setFpsMenuOpen(false)}>
                          {(['24', '30', '60'] as const).map((fps) => (
                            <DropdownItem
                              key={fps}
                              label={`${fps} fps`}
                              active={fpsValue === fps}
                              onClick={() => setFpsMenuOpen(false)}
                            />
                          ))}
                        </DropdownMenu>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>

              {/* Start Recording CTA */}
              <motion.div variants={ITEM_VARIANTS}>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  whileHover={{ y: -1 }}
                  disabled={isStarting}
                  onClick={() => void handleStartRecording()}
                  className={cn(
                    'w-full h-12 rounded-2xl flex items-center justify-center gap-2.5',
                    'bg-gradient-to-r from-jam-500 to-violet-400',
                    'hover:from-jam-600 hover:to-violet-500',
                    'text-white font-semibold text-sm shadow-jam',
                    'transition-all duration-200 relative overflow-hidden',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                  )}
                >
                  {/* Animated shimmer */}
                  <motion.div
                    className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
                    animate={{ x: ['-100%', '100%'] }}
                    transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
                  />
                  <span className="relative flex items-center gap-2.5">
                    <span className="w-2 h-2 rounded-full bg-white/90 animate-recording-pulse" />
                    <Play size={15} className="fill-white" />
                    <span>{isStarting ? 'Starting...' : 'Start Recording'}</span>
                  </span>
                </motion.button>
              </motion.div>

              {/* Recent Recordings */}
              <motion.div variants={ITEM_VARIANTS}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xxs font-semibold text-dark-500 uppercase tracking-widest">
                    Recent Recordings
                  </p>
                  {recentRecordings.length > 0 && (
                    <button
                      onClick={() => onNavigate('library')}
                      className="text-xxs font-medium text-jam-400 hover:text-jam-300 transition-colors"
                    >
                      View all
                    </button>
                  )}
                </div>

                {recentRecordings.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {recentRecordings.map((recording, i) => (
                      <RecentRecordingItem key={recording.id} recording={recording} index={i} />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-5 text-center">
                    <div className="w-10 h-10 rounded-xl bg-dark-800/80 border border-white/6 flex items-center justify-center">
                      <Monitor size={18} className="text-dark-500" />
                    </div>
                    <div>
                      <p className="text-xs font-medium text-dark-400">No recordings yet</p>
                      <p className="text-xxs text-dark-600 mt-0.5">
                        Start your first recording above
                      </p>
                    </div>
                  </div>
                )}
              </motion.div>
            </motion.div>
          ) : (
            /* ─── Screenshot Tab ─── */
            <motion.div
              key="screenshot-tab"
              variants={CONTAINER_VARIANTS}
              initial="hidden"
              animate="show"
              exit={{ opacity: 0 }}
              className="flex flex-col gap-3.5 px-4 pb-4"
            >
              {/* Screenshot Options */}
              <motion.div variants={ITEM_VARIANTS}>
                <p className="text-xxs font-semibold text-dark-500 uppercase tracking-widest mb-2">
                  Screenshot Options
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {SCREENSHOT_TYPES.map(({ type, icon, title, description }) => (
                    <RecordingTypeCard
                      key={type}
                      icon={icon}
                      title={title}
                      description={description}
                      selected={selectedScreenshotType === type}
                      onClick={() => setSelectedScreenshotType(type)}
                    />
                  ))}
                </div>
              </motion.div>

              {/* Controls Row */}
              <motion.div variants={ITEM_VARIANTS}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Delay dropdown */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDelayMenuOpen((v) => !v);
                      }}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-dark-800/70 border border-white/8 text-xxs font-medium text-dark-300 hover:text-white hover:border-white/16 transition-all"
                    >
                      <Timer size={11} />
                      <span>Delay: {screenshotDelay === 'none' ? 'None' : screenshotDelay}</span>
                      <ChevronDown size={10} />
                    </button>
                    <AnimatePresence>
                      {delayMenuOpen && (
                        <DropdownMenu onClose={() => setDelayMenuOpen(false)}>
                          {(['none', '3s', '5s'] as const).map((d) => (
                            <DropdownItem
                              key={d}
                              label={d === 'none' ? 'None' : d}
                              active={screenshotDelay === d}
                              onClick={() => {
                                setScreenshotDelay(d);
                                setDelayMenuOpen(false);
                              }}
                            />
                          ))}
                        </DropdownMenu>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Cursor toggle */}
                  <ToggleControl
                    icon={<MousePointer size={12} />}
                    label="Cursor"
                    value={includeCursor ? 'On' : 'Off'}
                    active={includeCursor}
                    onClick={() => setIncludeCursor((v) => !v)}
                  />

                  {/* Format dropdown */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setFormatMenuOpen((v) => !v);
                      }}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-dark-800/70 border border-white/8 text-xxs font-medium text-dark-300 hover:text-white hover:border-white/16 transition-all"
                    >
                      <span>Format: {screenshotFormat}</span>
                      <ChevronDown size={10} />
                    </button>
                    <AnimatePresence>
                      {formatMenuOpen && (
                        <DropdownMenu onClose={() => setFormatMenuOpen(false)}>
                          {(['PNG', 'JPG', 'WEBP'] as const).map((fmt) => (
                            <DropdownItem
                              key={fmt}
                              label={fmt}
                              active={screenshotFormat === fmt}
                              onClick={() => {
                                setScreenshotFormat(fmt);
                                setFormatMenuOpen(false);
                              }}
                            />
                          ))}
                        </DropdownMenu>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>

              {/* Take Screenshot CTA */}
              <motion.div variants={ITEM_VARIANTS}>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  whileHover={{ y: -1 }}
                  onClick={() => void handleScreenshot()}
                  className="w-full h-12 rounded-2xl flex items-center justify-center gap-2.5 bg-gradient-to-r from-jam-500 to-violet-400 hover:from-jam-600 hover:to-violet-500 text-white font-semibold text-sm shadow-jam transition-all duration-200 relative overflow-hidden"
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

              {/* Recent Screenshots empty state */}
              <motion.div variants={ITEM_VARIANTS}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xxs font-semibold text-dark-500 uppercase tracking-widest">
                    Recent Screenshots
                  </p>
                </div>
                <div className="flex flex-col items-center gap-2 py-5 text-center">
                  <div className="w-10 h-10 rounded-xl bg-dark-800/80 border border-white/6 flex items-center justify-center">
                    <Camera size={18} className="text-dark-500" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-dark-400">No screenshots yet</p>
                    <p className="text-xxs text-dark-600 mt-0.5">
                      Capture your first screenshot above
                    </p>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ─── Bottom Status Bar ─── */}
      <div className="px-4 py-2.5 border-t border-white/6 shrink-0">
        <div className="flex items-center justify-between">
          {/* Sync status */}
          <div className="flex items-center gap-1.5">
            {isOnline ? (
              <>
                <Cloud size={13} className="text-emerald-400" />
                <span className="text-xxs text-dark-400">All files synced</span>
              </>
            ) : (
              <>
                <CloudOff size={13} className="text-amber-400" />
                <span className="text-xxs text-amber-400">Offline</span>
              </>
            )}
          </div>

          {/* Storage usage */}
          <div className="flex items-center gap-1.5">
            <div className="w-20 h-1.5 rounded-full bg-dark-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-jam-500 to-violet-400 transition-all"
                style={{ width: `${storagePercent}%` }}
              />
            </div>
            <span className="text-xxs text-dark-500">
              {storageUsedGB} GB / {storageTotalGB} GB
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Tab Button ───────────────────────────────────────────────────────────────

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-medium transition-all duration-200',
        active
          ? 'bg-jam-500/20 text-jam-300 border border-jam-500/30'
          : 'text-dark-400 hover:text-dark-200 border border-transparent',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Toggle Control ───────────────────────────────────────────────────────────

interface ToggleControlProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  active: boolean;
  onClick: () => void;
}

function ToggleControl({ icon, label, value, active, onClick }: ToggleControlProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.93 }}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 px-2 py-1.5 rounded-lg text-xxs font-medium transition-all duration-200 border',
        active
          ? 'bg-jam-500/20 text-jam-300 border-jam-500/30'
          : 'bg-dark-800/70 text-dark-400 border-white/8 hover:text-white hover:border-white/16',
      )}
    >
      {icon}
      <span>{label}:</span>
      <span className={active ? 'text-jam-200 font-semibold' : 'text-dark-300'}>{value}</span>
    </motion.button>
  );
}

// ─── Dropdown Menu ────────────────────────────────────────────────────────────

interface DropdownMenuProps {
  children: React.ReactNode;
  onClose: () => void;
}

function DropdownMenu({ children }: DropdownMenuProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="absolute left-0 top-full mt-1 min-w-[100px] glass-card rounded-xl py-1 z-50"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </motion.div>
  );
}

interface DropdownItemProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function DropdownItem({ label, active, onClick }: DropdownItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-1.5 text-xs transition-colors',
        active
          ? 'text-jam-300 font-semibold bg-jam-500/10'
          : 'text-dark-300 hover:text-white hover:bg-white/6',
      )}
    >
      {label}
    </button>
  );
}

// ─── Recent Recording Item ────────────────────────────────────────────────────

interface RecentRecordingItemProps {
  recording: Recording;
  index: number;
}

function RecentRecordingItem({ recording, index }: RecentRecordingItemProps) {
  const handleOpen = () => {
    if (recording.shareUrl) {
      chrome.tabs.create({ url: recording.shareUrl });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04 }}
      className="flex items-center gap-2.5 p-2 rounded-xl hover:bg-dark-800/60 transition-all duration-150 group border border-transparent hover:border-white/6"
    >
      {/* Thumbnail */}
      <div className="w-12 h-8 rounded-lg overflow-hidden shrink-0 bg-dark-700/80 border border-white/6 flex items-center justify-center">
        {recording.thumbnailUrl ? (
          <img
            src={recording.thumbnailUrl}
            alt={recording.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <Monitor size={12} className="text-dark-500" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-white truncate group-hover:text-jam-200 transition-colors">
          {recording.title}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-xxs text-dark-500">{formatDuration(recording.duration)}</span>
          <span className="text-dark-700 text-xxs">·</span>
          <span className="text-xxs text-dark-500">{formatRelativeDate(recording.createdAt)}</span>
        </div>
      </div>

      {/* 3-dot menu */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleOpen}
          className="w-6 h-6 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all"
        >
          <ChevronRight size={12} />
        </button>
        <button className="w-6 h-6 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all">
          <MoreHorizontal size={12} />
        </button>
      </div>
    </motion.div>
  );
}
