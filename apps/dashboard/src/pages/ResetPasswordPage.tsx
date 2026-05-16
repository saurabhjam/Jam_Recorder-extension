import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, Lock, Eye, EyeOff, CheckCircle, ArrowLeft, AlertTriangle } from 'lucide-react';
import { Button } from '@components/ui/Button';
import { Input } from '@components/ui/Input';
import { api } from '@services/api';

// ─── Password strength ────────────────────────────────────────────────────────

interface StrengthResult {
  score: number; // 0-4
  label: string;
  color: string;
  barColor: string;
}

function getPasswordStrength(password: string): StrengthResult {
  if (!password) return { score: 0, label: '', color: 'text-gray-600', barColor: 'bg-gray-700' };

  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const capped = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;

  const map: Record<0 | 1 | 2 | 3 | 4, Omit<StrengthResult, 'score'>> = {
    0: { label: '', color: 'text-gray-600', barColor: 'bg-gray-700' },
    1: { label: 'Weak', color: 'text-red-400', barColor: 'bg-red-500' },
    2: { label: 'Fair', color: 'text-orange-400', barColor: 'bg-orange-500' },
    3: { label: 'Good', color: 'text-yellow-400', barColor: 'bg-yellow-500' },
    4: { label: 'Strong', color: 'text-emerald-400', barColor: 'bg-emerald-500' },
  };

  return { score: capped, ...map[capped] };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showCon, setShowCon] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});

  const strength = getPasswordStrength(password);

  // Redirect after success
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => navigate('/login', { replace: true }), 3000);
    return () => clearTimeout(timer);
  }, [success, navigate]);

  const validate = () => {
    const e: typeof errors = {};
    if (password.length < 8) e.password = 'Password must be at least 8 characters';
    if (password !== confirm) e.confirm = 'Passwords do not match';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setLoading(true);
    setError(null);
    try {
      await api.resetPassword(token!, password);
      setSuccess(true);
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'Failed to reset password.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // ── Invalid / missing token ──────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4 py-12">
        <div className="fixed inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-red-700/5 rounded-full blur-[100px]" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md text-center"
        >
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
              <AlertTriangle className="h-7 w-7 text-orange-400" />
            </div>
          </div>
          <h1 className="text-xl font-semibold text-gray-100 mb-2">Invalid reset link</h1>
          <p className="text-sm text-gray-400 mb-6 leading-relaxed">
            This password reset link is invalid or has expired. Please request a new one.
          </p>
          <Link
            to="/forgot-password"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 text-white text-sm font-medium hover:from-violet-500 hover:to-blue-500 transition-all"
          >
            Request new link
          </Link>
        </motion.div>
      </div>
    );
  }

  // ── Main form ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4 py-12">
      {/* Background gradient */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-violet-700/10 rounded-full blur-[100px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="w-full max-w-md"
      >
        {/* Logo */}
        <div className="flex flex-col items-center mb-8 text-center">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center shadow-lg shadow-violet-500/25 mb-4">
            <Zap className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-100">Reset your password</h1>
          <p className="mt-1 text-sm text-gray-500">
            Choose a strong new password for your account
          </p>
        </div>

        {/* Card */}
        <div className="card p-8 space-y-6">
          <AnimatePresence mode="wait">
            {success ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col items-center text-center py-4 space-y-4"
              >
                <div className="h-16 w-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                  <CheckCircle className="h-8 w-8 text-emerald-400" />
                </div>
                <div className="space-y-1">
                  <h2 className="text-base font-semibold text-gray-100">Password reset!</h2>
                  <p className="text-sm text-gray-400 leading-relaxed">
                    Your password has been successfully updated.
                    <br />
                    Redirecting to sign in…
                  </p>
                </div>
                <div className="h-1 w-32 bg-gray-800 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-violet-500 to-blue-500 rounded-full"
                    initial={{ width: '0%' }}
                    animate={{ width: '100%' }}
                    transition={{ duration: 3, ease: 'linear' }}
                  />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-5"
              >
                {/* Error banner */}
                {error && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400"
                  >
                    {error}
                  </motion.div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* New password */}
                  <div className="space-y-2">
                    <Input
                      label="New password"
                      type={showPw ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setErrors((p) => ({ ...p, password: undefined }));
                      }}
                      error={errors.password}
                      leftAddon={<Lock className="h-4 w-4" />}
                      rightAddon={
                        <button
                          type="button"
                          onClick={() => setShowPw(!showPw)}
                          className="cursor-pointer hover:text-gray-300 transition-colors"
                        >
                          {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      }
                      placeholder="••••••••"
                    />

                    {/* Strength indicator */}
                    {password.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="space-y-1.5"
                      >
                        <div className="flex gap-1">
                          {[1, 2, 3, 4].map((i) => (
                            <div
                              key={i}
                              className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                                i <= strength.score ? strength.barColor : 'bg-gray-800'
                              }`}
                            />
                          ))}
                        </div>
                        <div className="flex justify-between items-center">
                          <p className="text-[11px] text-gray-600">
                            {strength.score >= 3
                              ? 'Looking good!'
                              : 'Add uppercase, numbers, and symbols'}
                          </p>
                          {strength.label && (
                            <span className={`text-[11px] font-medium ${strength.color}`}>
                              {strength.label}
                            </span>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </div>

                  {/* Confirm password */}
                  <Input
                    label="Confirm new password"
                    type={showCon ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value);
                      setErrors((p) => ({ ...p, confirm: undefined }));
                    }}
                    error={errors.confirm}
                    leftAddon={<Lock className="h-4 w-4" />}
                    rightAddon={
                      <button
                        type="button"
                        onClick={() => setShowCon(!showCon)}
                        className="cursor-pointer hover:text-gray-300 transition-colors"
                      >
                        {showCon ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    }
                    placeholder="••••••••"
                  />

                  <Button
                    type="submit"
                    className="w-full"
                    size="lg"
                    loading={loading}
                    disabled={strength.score < 1}
                  >
                    Reset password
                  </Button>
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Back to login */}
        {!success && (
          <div className="mt-6 flex justify-center">
            <Link
              to="/login"
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to sign in
            </Link>
          </div>
        )}
      </motion.div>
    </div>
  );
}
