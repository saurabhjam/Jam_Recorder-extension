import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, Mail, ArrowLeft, CheckCircle } from 'lucide-react';
import { Button } from '@components/ui/Button';
import { Input } from '@components/ui/Input';
import { api } from '@services/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState<string | undefined>();

  const validate = () => {
    if (!email.trim()) {
      setEmailErr('Email is required');
      return false;
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
      setEmailErr('Enter a valid email address');
      return false;
    }
    setEmailErr(undefined);
    return true;
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setLoading(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSuccess(true);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

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
          <h1 className="text-2xl font-bold text-gray-100">Forgot your password?</h1>
          <p className="mt-1 text-sm text-gray-500">
            Enter your email and we'll send you a reset link
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
                  <h2 className="text-base font-semibold text-gray-100">Check your email</h2>
                  <p className="text-sm text-gray-400 leading-relaxed">
                    We've sent a password reset link to{' '}
                    <span className="text-gray-200 font-medium">{email}</span>.
                    <br />
                    It expires in 1 hour.
                  </p>
                </div>
                <p className="text-xs text-gray-600">
                  Didn't receive it?{' '}
                  <button
                    type="button"
                    className="text-violet-400 hover:text-violet-300 transition-colors"
                    onClick={() => {
                      setSuccess(false);
                      setError(null);
                    }}
                  >
                    Try again
                  </button>
                </p>
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
                  <Input
                    label="Email address"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setEmailErr(undefined);
                    }}
                    error={emailErr}
                    leftAddon={<Mail className="h-4 w-4" />}
                    placeholder="you@company.com"
                  />

                  <Button type="submit" className="w-full" size="lg" loading={loading}>
                    Send reset link
                  </Button>
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Back to login */}
        <div className="mt-6 flex justify-center">
          <Link
            to="/login"
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to sign in
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
