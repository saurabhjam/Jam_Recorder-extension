import { useState, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lock, User, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

interface LoginViewProps {
  onSuccess: () => void;
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const { login, isLoading, error, clearError } = useAuthStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!username.trim()) errors.username = 'Username is required';
    if (!password) errors.password = 'Password is required';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    if (!validate()) return;
    try {
      await login(username.trim(), password);
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
          <p className="text-sm text-dark-400 mt-1">Sign in with your ReportPortal account</p>
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
        </motion.form>
      </div>
    </div>
  );
}
