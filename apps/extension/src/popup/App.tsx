import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuthStore } from '@/store/auth.store';
import { useRecordingStore } from '@/store/recording.store';
import { useSettingsStore } from '@/store/settings.store';
import { LoginView } from './views/LoginView';
import { HomeView } from './views/HomeView';
import { RecordingView } from './views/RecordingView';
import { UploadView } from './views/UploadView';
import { LibraryView } from './views/LibraryView';
import { BugReportView } from './views/BugReportView';
import { AnnotationView } from './views/AnnotationView';
import { SettingsView } from './views/SettingsView';
import { MonitoringView } from './views/MonitoringView';

type View =
  | 'login'
  | 'home'
  | 'recording'
  | 'upload'
  | 'library'
  | 'settings'
  | 'bug-report'
  | 'annotation'
  | 'monitoring';

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
  const {
    status: recordingStatus,
    initialize: initRecording,
    reset: resetRecording,
  } = useRecordingStore();
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
        // Re-hydrate auth from storage, then land on home (the auto-route effect
        // won't move us off the login view on its own).
        void initAuth().then(() => setCurrentView('home'));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [initAuth]);

  // Re-surface the floating toolbar on the current tab, then close the popup.
  // If it can't be injected (restricted page) or the mount can't be verified,
  // keep the popup open on the recording controls so the user can always
  // pause/stop. The controls are shown immediately (not Home) so the popup
  // never flashes an irrelevant view before closing.
  const ensureToolbarThenRoute = async () => {
    setCurrentView('recording');
    try {
      const res = await new Promise<{ injected?: boolean } | undefined>((resolve) => {
        chrome.runtime.sendMessage({ type: 'ENSURE_TOOLBAR' }, (response) => {
          if (chrome.runtime.lastError) resolve(undefined);
          else resolve(response as { injected?: boolean } | undefined);
        });
      });
      // Close only when the background verified the toolbar is actually in the
      // page DOM — otherwise the user would be left with no controls at all.
      if (res?.injected) {
        window.close();
      }
    } catch {
      // stay on in-popup controls
    }
  };

  // Auto-route based on recording status
  useEffect(() => {
    if (isInitializing || authLoading) return;

    if (!isAuthenticated) {
      setCurrentView('login');
      return;
    }

    switch (recordingStatus) {
      case 'requesting':
        // Still acquiring the stream — the popup that started it closes itself.
        window.close();
        break;
      case 'recording':
      case 'paused':
        // The floating toolbar on the page is the control surface. It can be
        // lost (page navigation, content-script eviction) — so re-inject it into
        // the current tab, then close the popup once it's back. If the active
        // page is restricted (chrome://, Web Store, …) the toolbar can't live
        // there, so keep the popup open and show the recording controls in it.
        void ensureToolbarThenRoute();
        break;
      case 'uploading':
      case 'stopping':
        setCurrentView('upload');
        break;
      case 'done':
        resetRecording();
        setCurrentView('home');
        break;
      case 'idle':
      case 'error':
        if (currentView === 'upload') {
          setCurrentView('home');
        }
        break;
    }
  }, [recordingStatus, isAuthenticated, isInitializing, authLoading, resetRecording]); // eslint-disable-line react-hooks/exhaustive-deps

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

        {currentView === 'settings' && (
          <motion.div
            key="settings"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <SettingsView onBack={() => navigate('home')} />
          </motion.div>
        )}

        {currentView === 'monitoring' && (
          <motion.div
            key="monitoring"
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={PAGE_TRANSITION}
            className="flex-1 overflow-hidden"
          >
            <MonitoringView onBack={() => navigate('home')} />
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
      <p className="text-dark-400 text-sm">Loading BestQ...</p>
    </div>
  );
}
