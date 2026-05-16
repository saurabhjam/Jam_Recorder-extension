import { useState, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Lock, User, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

const API_BASE_URL: string = (() => {
  try {
    return (
      (import.meta as { env?: Record<string, string> }).env?.['VITE_API_BASE_URL'] ??
      'http://localhost:3000/api'
    );
  } catch {
    return 'http://localhost:3000/api';
  }
})();

interface LoginViewProps {
  onSuccess: () => void;
}

type AuthMode = 'login' | 'register';

export function LoginView({ onSuccess }: LoginViewProps) {
  const { login, register, isLoading, error, clearError } = useAuthStore();

  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errors: Record<string, string> = {};

    if (!email.trim()) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Enter a valid email address';
    }

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 8) {
      errors.password = 'Password must be at least 8 characters';
    }

    if (mode === 'register' && !name.trim()) {
      errors.name = 'Name is required';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (!validate()) return;

    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password, name);
      }
      onSuccess();
    } catch {
      // Error is set in the store
    }
  };

  const handleModeSwitch = (newMode: AuthMode) => {
    setMode(newMode);
    clearError();
    setFieldErrors({});
  };

  const handleGoogleLogin = () => {
    chrome.tabs.create({ url: `${API_BASE_URL}/auth/google` });
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-8 pb-6">
        {/* Logo */}
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
          <h1 className="text-xl font-bold text-white">
            {mode === 'login' ? 'Welcome back' : 'Create account'}
          </h1>
          <p className="text-sm text-dark-400 mt-1">
            {mode === 'login' ? 'Sign in to SnapTrace' : 'Start recording in seconds'}
          </p>
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
          {/* Google OAuth */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            className="w-full h-10 rounded-xl border border-white/10 bg-dark-800 hover:bg-dark-700 text-sm font-medium text-white transition-all duration-200 flex items-center justify-center gap-2.5"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </button>

          {/* OR divider */}
          <div className="relative flex items-center gap-3">
            <div className="flex-1 h-px bg-white/8" />
            <span className="text-xxs text-dark-500 font-medium">or</span>
            <div className="flex-1 h-px bg-white/8" />
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

          {/* Name field (register only) */}
          <AnimatePresence>
            {mode === 'register' && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                <Input
                  label="Full Name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Doe"
                  error={fieldErrors.name}
                  leftIcon={<User size={15} />}
                  autoComplete="name"
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Email */}
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            error={fieldErrors.email}
            leftIcon={<Mail size={15} />}
            autoComplete="email"
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
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />

          {/* Forgot password (login only) */}
          {mode === 'login' && (
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: 'http://localhost:3001/forgot-password' })}
              className="text-xxs text-jam-400 hover:text-jam-300 transition-colors text-right self-end"
            >
              Forgot password?
            </button>
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
            {mode === 'login' ? 'Sign In' : 'Create Account'}
          </Button>

          {/* Mode Switch */}
          <p className="text-center text-xs text-dark-400 mt-1">
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              onClick={() => handleModeSwitch(mode === 'login' ? 'register' : 'login')}
              className="text-jam-400 hover:text-jam-300 font-semibold transition-colors"
            >
              {mode === 'login' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        </motion.form>
      </div>
    </div>
  );
}
