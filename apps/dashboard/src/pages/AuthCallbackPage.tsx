import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Zap, AlertCircle } from 'lucide-react';
import { useAuthStore } from '../store/auth.store';

export function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setTokensFromOAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    const token = searchParams.get('accessToken');
    const refreshToken = searchParams.get('refreshToken');
    const expiresAt = searchParams.get('expiresAt');
    const errorMsg = searchParams.get('error');

    if (errorMsg) {
      setError(decodeURIComponent(errorMsg));
      const interval = setInterval(() => setCountdown((c) => c - 1), 1000);
      setTimeout(() => {
        clearInterval(interval);
        navigate('/login', { replace: true });
      }, 3000);
      return () => clearInterval(interval);
    }

    if (!token || !refreshToken) {
      setError('Invalid authentication response. Missing token.');
      const interval = setInterval(() => setCountdown((c) => c - 1), 1000);
      setTimeout(() => {
        clearInterval(interval);
        navigate('/login', { replace: true });
      }, 3000);
      return () => clearInterval(interval);
    }

    // Store tokens and fetch user
    setTokensFromOAuth(token, refreshToken, expiresAt ? Number(expiresAt) : undefined)
      .then(() => {
        navigate('/dashboard', { replace: true });
      })
      .catch((err: Error) => {
        setError(err.message ?? 'Failed to complete sign-in.');
        const interval = setInterval(() => setCountdown((c) => c - 1), 1000);
        setTimeout(() => {
          clearInterval(interval);
          navigate('/login', { replace: true });
        }, 3000);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="fixed inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-red-700/5 rounded-full blur-[100px]" />
        </div>

        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-sm text-center"
        >
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
              <AlertCircle className="h-7 w-7 text-red-400" />
            </div>
          </div>
          <h1 className="text-xl font-semibold text-gray-100 mb-2">Sign-in failed</h1>
          <p className="text-sm text-gray-400 mb-4 leading-relaxed">{error}</p>
          <p className="text-xs text-gray-600">
            Redirecting to login in <span className="text-gray-400 font-medium">{countdown}s</span>…
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-violet-700/10 rounded-full blur-[100px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm text-center"
      >
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <motion.div
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            className="h-14 w-14 rounded-2xl bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center shadow-lg shadow-violet-500/30"
          >
            <Zap className="h-7 w-7 text-white" />
          </motion.div>
        </div>

        {/* Spinner */}
        <div className="flex justify-center mb-6">
          <svg
            className="h-10 w-10 animate-spin text-violet-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-20"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
            />
            <path
              className="opacity-80"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>

        <h1 className="text-xl font-semibold text-gray-100 mb-1">Completing sign-in…</h1>
        <p className="text-sm text-gray-500">Please wait while we verify your Google account.</p>
      </motion.div>
    </div>
  );
}
