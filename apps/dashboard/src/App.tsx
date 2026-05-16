import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { DashboardLayout } from '@layouts/DashboardLayout';
import { useAuthStore } from '@store/auth.store';

// Pages
import LoginPage from '@pages/LoginPage';
import RegisterPage from '@pages/RegisterPage';
import SharePage from '@pages/SharePage';
import DashboardPage from '@pages/DashboardPage';
import LibraryPage from '@pages/LibraryPage';
import TeamPage from '@pages/TeamPage';
import AnalyticsPage from '@pages/AnalyticsPage';
import SettingsPage from '@pages/SettingsPage';
import BillingPage from '@pages/BillingPage';
import { AuthCallbackPage } from '@pages/AuthCallbackPage';
import ForgotPasswordPage from '@pages/ForgotPasswordPage';
import ResetPasswordPage from '@pages/ResetPasswordPage';

// ─── Auth Guard ───────────────────────────────────────────────────────────────

function AuthGuard({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

// ─── Page title map ───────────────────────────────────────────────────────────

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/library': 'Library',
  '/team': 'Team',
  '/analytics': 'Analytics',
  '/settings': 'Settings',
  '/billing': 'Billing',
};

// ─── Protected layout wrapper ─────────────────────────────────────────────────

function ProtectedPage({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const title = PAGE_TITLES[location.pathname];

  return (
    <AuthGuard>
      <DashboardLayout title={title}>{children}</DashboardLayout>
    </AuthGuard>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Protected routes */}
      <Route
        path="/dashboard"
        element={
          <ProtectedPage>
            <DashboardPage />
          </ProtectedPage>
        }
      />
      <Route
        path="/library"
        element={
          <ProtectedPage>
            <LibraryPage />
          </ProtectedPage>
        }
      />
      <Route
        path="/team"
        element={
          <ProtectedPage>
            <TeamPage />
          </ProtectedPage>
        }
      />
      <Route
        path="/analytics"
        element={
          <ProtectedPage>
            <AnalyticsPage />
          </ProtectedPage>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedPage>
            <SettingsPage />
          </ProtectedPage>
        }
      />
      <Route
        path="/billing"
        element={
          <ProtectedPage>
            <BillingPage />
          </ProtectedPage>
        }
      />

      {/* Default redirect */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
