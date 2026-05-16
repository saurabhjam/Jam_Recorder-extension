import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '@store/auth.store';
import { api } from '@services/api';

export function useAuth() {
  const { user, tokens, isAuthenticated, isLoading, login, logout, updateUser, setLoading } =
    useAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ─── Login ────────────────────────────────────────────────────────────────
  const loginMutation = useMutation({
    mutationFn: (creds: { email: string; password: string }) => api.login(creds),
    onSuccess: ({ user: u, tokens: t }) => {
      login(u, t);
      toast.success(`Welcome back, ${u.name}!`);
      navigate('/dashboard');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  // ─── Register ─────────────────────────────────────────────────────────────
  const registerMutation = useMutation({
    mutationFn: (body: { name: string; email: string; password: string }) => api.register(body),
    onSuccess: ({ user: u, tokens: t }) => {
      login(u, t);
      toast.success('Account created! Welcome to SnapTrace!');
      navigate('/dashboard');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  // ─── Logout ───────────────────────────────────────────────────────────────
  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      logout();
      queryClient.clear();
      navigate('/login');
    }
  }, [logout, navigate, queryClient]);

  // ─── Update profile ───────────────────────────────────────────────────────
  const updateProfileMutation = useMutation({
    mutationFn: (body: { name?: string; avatar?: string }) => api.updateProfile(body),
    onSuccess: (updatedUser) => {
      updateUser(updatedUser);
      toast.success('Profile updated');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  // ─── Change password ──────────────────────────────────────────────────────
  const changePasswordMutation = useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.changePassword(body),
    onSuccess: () => {
      toast.success('Password changed successfully');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return {
    user,
    tokens,
    isAuthenticated,
    isLoading,
    login: loginMutation.mutateAsync,
    loginPending: loginMutation.isPending,
    register: registerMutation.mutateAsync,
    registerPending: registerMutation.isPending,
    logout: handleLogout,
    updateProfile: updateProfileMutation.mutateAsync,
    updateProfilePending: updateProfileMutation.isPending,
    changePassword: changePasswordMutation.mutateAsync,
    changePasswordPending: changePasswordMutation.isPending,
    setLoading,
    updateUser,
  };
}
