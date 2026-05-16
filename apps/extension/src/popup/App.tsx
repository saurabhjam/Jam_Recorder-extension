import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuthStore } from '@/store/auth.store';
import { useRecordingStore } from '@/store/recording.store';
import { useSettingsStore } from '@/store/settings.store';
import { LoginView } from './views/LoginView';
import { HomeView } from './views/HomeView';
import { RecordingView } from './views/RecordingView';
import { UploadView } from './views/UploadView';
import { ShareView } from './views/ShareView';
import { LibraryView } from './views/LibraryView';
import { BugReportView } from './views/BugReportView';
import { AnnotationView } from './views/AnnotationView';

type View =
  | 'login'
  | 'home'
  | 'recording'
  | 'upload'
  | 'share'
  | 'library'
  | 'settings'
  | 'bug-report'
  | 'annotation';

const PAGE_VARIANTS = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
};

const PAGE_TRANSITION = {
  type: 'tween' as const,
  duration: 0.2,
  ease: 'easeInOut',
};

export default function App() {
  const { isAuthenticated, isLoading: authLoading, initialize: initAuth } = useAuthStore();
  const { status: recordingStatus, initialize: initRecording } = useRecordingStore();
  const { initialize: initSettings } = useSettingsStore();
  const [currentView, setCurrentView] = useState<View>('home');
  const [isInitializing, setIsInitializing] = useState(true);
  const [annotationImageUrl, setAnnotationImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      await Promise.all([initAuth(), initSettings()]);
      // Sync recording state and any pending share result from background
      await initRecording();
      setIsInitializing(false);
    };
    void init();
  }, [initAuth, initSettings, initRecording]);

  // Re-initialize auth when the background broadcasts an auth state change.
  // OAUTH_LOGIN_COMPLETE fires when the Google OAuth tab is intercepted and
  // tokens have been stored — re-reading storage is enough to log in.
  useEffect(() => {
    const listener = (message: { type: string; payload?: { isAuthenticated?: boolean } }) => {
      if (message.type === 'AUTH_STATE_CHANGED' && message.payload?.isAuthenticated === false) {
        void initAuth();
      }
      if (message.type === 'OAUTH_LOGIN_COMPLETE') {
        void initAuth();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [initAuth]);

  // Auto-route based on recording status
  useEffect(() => {
    if (isInitializing || authLoading) return;

    if (!isAuthenticated) {
      setCurrentView('login');
      return;
    }

    switch (recordingStatus) {
      case 'recording':
      case 'paused':
      case 'requesting':
        setCurrentView('recording');
        break;
      case 'uploading':
      case 'stopping':
        setCurrentView('upload');
        break;
      case 'done':
        setCurrentView('share');
        break;
      case 'idle':
      case 'error':
        if (currentView === 'recording' || currentView === 'upload') {
          setCurrentView('home');
        }
        break;
    }
  }, [recordingStatus, isAuthenticated, isInitializing, authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isInitializing || authLoading) {
    return (
      <div className="w-full h-[500px] flex items-center justify-center bg-dark-950">
        <LoadingSpinner />
      </div>
    );
  }

  const navigate = (view: View) => setCurrentView(view);

  return (
    <div className="w-[380px] h-[580px] bg-dark-950 flex flex-col overflow-hidden relative">
      {/* Background gradient decoration */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-20 -right-20 w-60 h-60 rounded-full bg-indigo-600/10 blur-3xl" />
        <div className="absolute -bottom-10 -left-10 w-40 h-40 rounded-full bg-violet-600/8 blur-2xl" />
      </div>

      <AnimatePresence mode="wait">
        {currentView === 'login' && (
          <motion.div
            key="login"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <LoginView onSuccess={() => navigate('home')} />
          </motion.div>
        )}

        {currentView === 'home' && (
          <motion.div
            key="home"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <HomeView onNavigate={navigate} />
          </motion.div>
        )}

        {currentView === 'recording' && (
          <motion.div
            key="recording"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <RecordingView onCancel={() => navigate('home')} />
          </motion.div>
        )}

        {currentView === 'upload' && (
          <motion.div
            key="upload"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <UploadView />
          </motion.div>
        )}

        {currentView === 'share' && (
          <motion.div
            key="share"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <ShareView onRecordAnother={() => navigate('home')} />
          </motion.div>
        )}

        {currentView === 'library' && (
          <motion.div
            key="library"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <LibraryView onBack={() => navigate('home')} />
          </motion.div>
        )}

        {currentView === 'bug-report' && (
          <motion.div
            key="bug-report"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <BugReportView
              onCancel={() => navigate('home')}
              onAnnotate={(screenshotUrl) => {
                setAnnotationImageUrl(screenshotUrl);
                navigate('annotation');
              }}
            />
          </motion.div>
        )}

        {currentView === 'annotation' && annotationImageUrl && (
          <motion.div
            key="annotation"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <AnnotationView
              imageUrl={annotationImageUrl}
              onSave={() => {
                setAnnotationImageUrl(null);
                navigate('bug-report');
              }}
              onBack={() => {
                setAnnotationImageUrl(null);
                navigate('bug-report');
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-blue-500 flex items-center justify-center shadow-lg animate-scale-in">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-white">
          <circle
            cx="12"
            cy="12"
            r="8"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="4 2"
            className="animate-upload-spin"
          />
          <circle cx="12" cy="12" r="3" fill="currentColor" className="animate-recording-pulse" />
        </svg>
      </div>
      <p className="text-dark-400 text-sm">Loading SnapTrace...</p>
    </div>
  );
}
