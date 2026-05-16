import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Monitor,
  Chrome,
  Camera,
  Image,
  Settings,
  Library,
  Mic,
  MicOff,
  Video,
  VideoOff,
  LogOut,
  ChevronRight,
  Bug,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { useRecordingStore } from '@/store/recording.store';
import { useSettingsStore } from '@/store/settings.store';
import { RecordingTypeCard } from '@/components/RecordingTypeCard';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatRelativeDate, formatDuration } from '@/utils';
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

interface HomeViewProps {
  onNavigate: (view: View) => void;
}

const CONTAINER_VARIANTS = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.1 },
  },
};

const ITEM_VARIANTS = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 350, damping: 25 } },
};

const RECORDING_TYPES: Array<{
  type: RecordingType;
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
}> = [
  {
    type: 'screen',
    icon: <Monitor size={20} />,
    title: 'Screen',
    description: 'Full screen',
  },
  {
    type: 'tab',
    icon: <Chrome size={20} />,
    title: 'Tab',
    description: 'This tab',
  },
  {
    type: 'webcam',
    icon: <Camera size={20} />,
    title: 'Webcam',
    description: 'Camera only',
  },
];

export function HomeView({ onNavigate }: HomeViewProps) {
  const { user, logout } = useAuthStore();
  const { recordings, startRecording, takeScreenshot } = useRecordingStore();
  const { settings, toggleMic, toggleWebcam } = useSettingsStore();
  const [selectedType, setSelectedType] = useState<RecordingType>('screen');
  const [isStarting, setIsStarting] = useState(false);

  const recentRecordings = recordings.slice(0, 5);

  const handleStartRecording = async () => {
    // For webcam recording, validate camera access before starting
    if (selectedType === 'webcam') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        alert(
          'Camera access is required for webcam recording. Please grant camera permission and try again.',
        );
        return;
      }
    }

    setIsStarting(true);
    try {
      await startRecording({
        type: selectedType,
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

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex items-center justify-between px-4 pt-4 pb-3"
      >
        {/* Logo + Title */}
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-blue-500 flex items-center justify-center shadow-lg">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 2L14 8L8 14L2 8L8 2Z" fill="white" fillOpacity="0.9" />
              <circle cx="8" cy="8" r="2.5" fill="white" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold leading-none bg-gradient-to-r from-indigo-400 via-violet-400 to-blue-400 bg-clip-text text-transparent">
              SnapTrace
            </h1>
            <p className="text-xxs text-dark-400 mt-0.5">Ready to record</p>
          </div>
        </div>

        {/* User Menu */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onNavigate('bug-report')}
            className="icon-btn"
            title="Report a Bug"
          >
            <Bug size={16} />
          </button>
          <button onClick={() => onNavigate('library')} className="icon-btn" title="Library">
            <Library size={16} />
          </button>
          <button onClick={() => onNavigate('settings')} className="icon-btn" title="Settings">
            <Settings size={16} />
          </button>
          {user && (
            <div className="relative group">
              <button className="flex items-center gap-1.5 rounded-xl px-2 py-1 hover:bg-white/6 transition-colors">
                <Avatar src={user.avatar ?? undefined} name={user.name} size="xs" />
                <span className="text-xs text-dark-300 max-w-[60px] truncate">
                  {user.name.split(' ')[0]}
                </span>
              </button>
              {/* Dropdown */}
              <div className="absolute right-0 top-full mt-1 w-36 glass-card rounded-xl py-1.5 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 border border-white/8">
                <button
                  onClick={() => logout()}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-dark-300 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <LogOut size={12} />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </motion.div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin px-4 pb-4">
        <motion.div
          variants={CONTAINER_VARIANTS}
          initial="hidden"
          animate="show"
          className="flex flex-col gap-4"
        >
          {/* Recording Type Selector */}
          <motion.div variants={ITEM_VARIANTS}>
            <p className="text-xxs font-semibold text-dark-400 uppercase tracking-widest mb-2.5">
              Recording Mode
            </p>
            <div className="grid grid-cols-3 gap-2">
              {RECORDING_TYPES.map(({ type, icon, title, description, badge }) => (
                <RecordingTypeCard
                  key={type}
                  icon={icon}
                  title={title}
                  description={description}
                  badge={badge}
                  selected={selectedType === type}
                  onClick={() => setSelectedType(type)}
                />
              ))}
            </div>
          </motion.div>

          {/* Quick Toggles */}
          <motion.div variants={ITEM_VARIANTS}>
            <div className="flex items-center gap-2">
              <QuickToggle
                icon={settings.micEnabled ? <Mic size={14} /> : <MicOff size={14} />}
                label="Mic"
                active={settings.micEnabled}
                onClick={() => void toggleMic()}
              />
              <QuickToggle
                icon={settings.webcamOverlay ? <Video size={14} /> : <VideoOff size={14} />}
                label="Camera overlay"
                active={settings.webcamOverlay}
                onClick={() => void toggleWebcam()}
              />
              <Badge variant={settings.recordingQuality === 'high' ? 'primary' : 'ghost'} size="sm">
                {settings.recordingQuality.toUpperCase()}
              </Badge>
            </div>
          </motion.div>

          {/* Start Recording CTA */}
          <motion.div variants={ITEM_VARIANTS} className="flex gap-2">
            <Button
              variant="primary"
              size="lg"
              fullWidth
              loading={isStarting}
              onClick={() => void handleStartRecording()}
              leftIcon={<span className="w-2 h-2 rounded-full bg-white animate-recording-pulse" />}
            >
              {isStarting ? 'Starting...' : `Record ${selectedType}`}
            </Button>

            <Button
              variant="secondary"
              size="lg"
              onClick={() => void handleScreenshot()}
              leftIcon={<Image size={16} />}
              title="Take Screenshot"
              className="shrink-0 px-3"
            >
              <span className="sr-only">Screenshot</span>
            </Button>
          </motion.div>

          {/* Plan Banner — shown when no team is assigned (free tier proxy) */}
          {user && !user.teamId && (
            <motion.div variants={ITEM_VARIANTS}>
              <div className="relative overflow-hidden rounded-2xl p-3 bg-gradient-to-r from-jam-900/60 to-violet-900/40 border border-jam-500/20">
                <div className="absolute inset-0 bg-gradient-to-r from-jam-600/10 to-violet-600/10" />
                <div className="relative flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold text-jam-300">Upgrade to Pro</p>
                    <p className="text-xxs text-dark-400 mt-0.5">
                      Unlimited recordings, 4K, custom branding
                    </p>
                  </div>
                  <button className="shrink-0 text-xs font-semibold text-jam-300 hover:text-white transition-colors flex items-center gap-1">
                    Upgrade <ChevronRight size={12} />
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Recent Recordings */}
          {recentRecordings.length > 0 && (
            <motion.div variants={ITEM_VARIANTS}>
              <div className="flex items-center justify-between mb-2.5">
                <p className="text-xxs font-semibold text-dark-400 uppercase tracking-widest">
                  Recent
                </p>
                <button
                  onClick={() => onNavigate('library')}
                  className="text-xxs text-jam-400 hover:text-jam-300 transition-colors font-medium"
                >
                  See all
                </button>
              </div>
              <div className="flex flex-col gap-2">
                {recentRecordings.map((recording, i) => (
                  <RecentRecordingItem key={recording.id} recording={recording} index={i} />
                ))}
              </div>
            </motion.div>
          )}

          {/* Empty state */}
          {recentRecordings.length === 0 && (
            <motion.div
              variants={ITEM_VARIANTS}
              className="flex flex-col items-center gap-2 py-6 text-center"
            >
              <div className="w-12 h-12 rounded-2xl bg-dark-800 flex items-center justify-center">
                <Monitor size={20} className="text-dark-500" />
              </div>
              <p className="text-sm font-medium text-dark-400">No recordings yet</p>
              <p className="text-xs text-dark-500">Start your first recording above</p>
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

// ─── Quick Toggle ─────────────────────────────────────────────────────────────

interface QuickToggleProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

function QuickToggle({ icon, label, active, onClick }: QuickToggleProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium transition-all duration-200 border ${
        active
          ? 'bg-jam-500/20 text-jam-300 border-jam-500/30'
          : 'bg-dark-800/60 text-dark-400 border-white/6 hover:border-white/12'
      }`}
    >
      {icon}
      <span>{label}</span>
    </motion.button>
  );
}

// ─── Recent Recording Item ────────────────────────────────────────────────────

const RECORDING_TYPE_ICONS: Record<string, React.ReactNode> = {
  screen: <Monitor size={12} />,
  tab: <Chrome size={12} />,
  webcam: <Camera size={12} />,
  screenshot: <Image size={12} />,
};

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
    <motion.button
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05 }}
      whileHover={{ x: 2 }}
      onClick={handleOpen}
      className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-dark-800/60 transition-all duration-150 group text-left w-full border border-transparent hover:border-white/6"
    >
      {/* Thumbnail / Icon */}
      <div className="w-10 h-7 rounded-lg overflow-hidden shrink-0 bg-dark-700 flex items-center justify-center border border-white/5">
        {recording.thumbnailUrl ? (
          <img
            src={recording.thumbnailUrl}
            alt={recording.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-dark-400">
            {RECORDING_TYPE_ICONS[recording.type] ?? <Monitor size={12} />}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-white truncate group-hover:text-jam-200 transition-colors">
          {recording.title}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-xxs text-dark-500">{formatDuration(recording.duration)}</span>
          <span className="text-dark-600 text-xxs">·</span>
          <span className="text-xxs text-dark-500">{formatRelativeDate(recording.createdAt)}</span>
        </div>
      </div>

      {/* Arrow */}
      <ChevronRight
        size={14}
        className="text-dark-600 group-hover:text-dark-400 transition-colors shrink-0"
      />
    </motion.button>
  );
}
