import { useState, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lock, User, Eye, EyeOff, AlertCircle, KeyRound } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { InstanceBadge } from '@/components/ui/InstanceBadge';

/** Google "G" mark — inline so it works under the extension's strict CSP. */
function GoogleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

interface LoginViewProps {
  onSuccess: () => void;
}

type LoginMode = 'password' | 'token';

export function LoginView({ onSuccess }: LoginViewProps) {
  const { login, loginWithToken, isLoading, error, clearError } = useAuthStore();

  const [mode, setMode] = useState<LoginMode>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const switchMode = (next: LoginMode) => {
    if (next === mode) return;
    clearError();
    setFieldErrors({});
    setMode(next);
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (mode === 'password') {
      if (!username.trim()) errors.username = 'Username is required';
      if (!password) errors.password = 'Password is required';
    } else {
      if (!token.trim()) errors.token = 'Token is required';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleGoogleLogin = () => {
    clearError();
    // Ask the background to open ReportPortal's Google OAuth flow in a tab and
    // capture the bearer token the UI receives (see background/index.ts). The
    // popup closes when the tab opens; auth completes in the background and is
    // reflected via the OAUTH_LOGIN_COMPLETE broadcast / on next popup open.
    chrome.runtime.sendMessage({ type: 'START_GOOGLE_LOGIN' }).catch(() => {});
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    if (!validate()) return;
    try {
      if (mode === 'password') {
        await login(username.trim(), password);
      } else {
        await loginWithToken(token.trim());
      }
      onSuccess();
    } catch {
      // Error is set in the store
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-8 pb-6">
        <motion.div
          initial={{ scale: 0, rotate: -15 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 350, damping: 20 }}
          className="w-14 h-14 rounded-2xl bg-gradient-to-br from-jam-500 to-violet-600 flex items-center justify-center shadow-jam mx-auto mb-4"
        >
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <circle cx="14" cy="14" r="6" fill="white" />
            <circle cx="14" cy="14" r="10" stroke="white" strokeWidth="2" strokeOpacity="0.5" />
            <circle cx="14" cy="14" r="13" stroke="white" strokeWidth="1" strokeOpacity="0.2" />
          </svg>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="text-center"
        >
          <h1 className="text-xl font-bold text-white">Welcome back</h1>
          <p className="text-sm text-dark-400 mt-1">
            {mode === 'password'
              ? 'Sign in with your ReportPortal account'
              : 'Sign in with an access token'}
          </p>
          <div className="flex justify-center mt-3">
            <InstanceBadge size={16} />
          </div>
        </motion.div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto scrollbar-none px-6 pb-6">
        <motion.form
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col gap-3"
          noValidate
        >
          {/* Mode toggle */}
          <div className="flex p-1 rounded-xl bg-dark-900/80 border border-jam-500/20">
            {(['password', 'token'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  mode === m ? 'bg-jam-500/20 text-white' : 'text-dark-400 hover:text-dark-200'
                }`}
              >
                {m === 'password' ? <User size={13} /> : <KeyRound size={13} />}
                {m === 'password' ? 'Password' : 'Token'}
              </button>
            ))}
          </div>

          {/* Global Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs"
              >
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {mode === 'password' ? (
            <>
              {/* Username */}
              <Input
                label="Username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="superadmin"
                error={fieldErrors.username}
                leftIcon={<User size={15} />}
                autoComplete="username"
              />

              {/* Password */}
              <Input
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                error={fieldErrors.password}
                leftIcon={<Lock size={15} />}
                rightIcon={
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="text-dark-400 hover:text-dark-200 transition-colors"
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                }
                autoComplete="current-password"
              />
            </>
          ) : (
            /* Access token */
            <Input
              label="Access Token"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your access token"
              error={fieldErrors.token}
              helperText="Your token is validated before sign in."
              leftIcon={<KeyRound size={15} />}
              autoComplete="off"
            />
          )}

          {/* Submit */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={isLoading}
            className="mt-1"
          >
            Sign In
          </Button>

          {/* Divider */}
          <div className="flex items-center gap-3 my-1">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-[11px] uppercase tracking-wide text-dark-500">or</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          {/* Continue with Google */}
          <Button
            type="button"
            variant="secondary"
            size="lg"
            fullWidth
            disabled={isLoading}
            leftIcon={<GoogleIcon size={18} />}
            onClick={handleGoogleLogin}
          >
            Continue with Google
          </Button>
        </motion.form>
      </div>
    </div>
  );
}
