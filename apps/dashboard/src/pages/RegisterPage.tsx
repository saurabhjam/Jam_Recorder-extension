import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Zap, Mail, Lock, User, Eye, EyeOff } from 'lucide-react';
import { Button } from '@components/ui/Button';
import { Input } from '@components/ui/Input';
import { useAuth } from '@hooks/useAuth';

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:3000';

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
        fill="#EA4335"
      />
    </svg>
  );
}

export default function RegisterPage() {
  const { register, registerPending } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Name is required';
    if (!email.trim()) e.email = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(email)) e.email = 'Enter a valid email';
    if (password.length < 8) e.password = 'Password must be at least 8 characters';
    if (password !== confirm) e.confirm = 'Passwords do not match';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    try {
      await register({ name: name.trim(), email: email.trim(), password });
    } catch (err: unknown) {
      setErrors({ global: (err as Error).message });
    }
  };

  const handleGoogleSignUp = () => {
    window.location.href = `${BACKEND_URL}/api/auth/google`;
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4 py-12">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-violet-700/10 rounded-full blur-[100px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="w-full max-w-md"
      >
        <div className="flex flex-col items-center mb-8 text-center">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center shadow-lg shadow-violet-500/25 mb-4">
            <Zap className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-100">Create your account</h1>
          <p className="mt-1 text-sm text-gray-500">Start recording with SnapTrace — it's free</p>
        </div>

        <div className="card p-8 space-y-6">
          {errors.global && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400"
            >
              {errors.global}
            </motion.div>
          )}

          {/* Google OAuth */}
          <button
            type="button"
            onClick={handleGoogleSignUp}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.10] text-gray-200 text-sm font-medium hover:bg-white/[0.08] hover:border-white/[0.16] transition-all duration-200"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/[0.06]" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-gray-900 px-4 text-xs text-gray-500">or sign up with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Full name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={errors.name}
              leftAddon={<User className="h-4 w-4" />}
              placeholder="Jane Smith"
            />

            <Input
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email}
              leftAddon={<Mail className="h-4 w-4" />}
              placeholder="you@company.com"
            />

            <Input
              label="Password"
              type={showPw ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              leftAddon={<Lock className="h-4 w-4" />}
              hint="Minimum 8 characters"
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

            <Input
              label="Confirm password"
              type={showPw ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              error={errors.confirm}
              leftAddon={<Lock className="h-4 w-4" />}
              placeholder="••••••••"
            />

            <Button type="submit" className="w-full mt-2" size="lg" loading={registerPending}>
              Create account
            </Button>
          </form>

          <p className="text-center text-sm text-gray-500">
            Already have an account?{' '}
            <Link
              to="/login"
              className="text-violet-400 hover:text-violet-300 font-medium transition-colors"
            >
              Sign in
            </Link>
          </p>
        </div>

        <p className="mt-8 text-center text-xs text-gray-600">
          By creating an account, you agree to our{' '}
          <span className="text-gray-500 hover:text-gray-400 cursor-pointer">Terms</span> and{' '}
          <span className="text-gray-500 hover:text-gray-400 cursor-pointer">Privacy Policy</span>
        </p>
      </motion.div>
    </div>
  );
}
