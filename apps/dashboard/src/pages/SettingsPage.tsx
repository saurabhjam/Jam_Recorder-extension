import React, { useState, useRef } from 'react';
import {
  User,
  Lock,
  Bell,
  Key,
  Trash2,
  Upload,
  Check,
  Monitor,
  Smartphone,
  Shield,
  AlertTriangle,
  Settings,
  Sliders,
  Video,
  Zap,
  CreditCard,
  Users,
  ChevronRight,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@components/ui/Button';
import { Input } from '@components/ui/Input';
import { Badge } from '@components/ui/Badge';
import { Modal, ModalFooter } from '@components/ui/Modal';
import { useAuth } from '@hooks/useAuth';
import { api } from '@services/api';
import { getInitials } from '@utils/index';
import * as Switch from '@radix-ui/react-switch';

// ─── Data ──────────────────────────────────────────────────────────────────────

const RECORDING_PREFS = [
  {
    key: 'startWithCamera',
    label: 'Start recording with camera',
    description: 'Enable webcam when starting a new recording',
    icon: <Video className="h-4 w-4 text-violet-400" />,
  },
  {
    key: 'startWithMic',
    label: 'Start recording with mic',
    description: 'Enable microphone when starting a new recording',
    icon: <Bell className="h-4 w-4 text-blue-400" />,
  },
  {
    key: 'autoCopyLink',
    label: 'Auto copy link after upload',
    description: 'Automatically copy the share link when upload completes',
    icon: <Zap className="h-4 w-4 text-amber-400" />,
  },
  {
    key: 'showCountdown',
    label: 'Show countdown before recording',
    description: 'Display a 3-second countdown before recording starts',
    icon: <Settings className="h-4 w-4 text-emerald-400" />,
  },
  {
    key: 'autoUpload',
    label: 'Auto upload to cloud',
    description: 'Automatically upload recordings to the cloud when finished',
    icon: <Upload className="h-4 w-4 text-rose-400" />,
  },
];

const NOTIFICATION_PREFS = [
  {
    key: 'recordingReady',
    label: 'Recording processed',
    description: 'When your recording is ready to share',
  },
  {
    key: 'newComment',
    label: 'New comments',
    description: 'When someone comments on your recording',
  },
  { key: 'teamInvite', label: 'Team invitations', description: 'When you receive a team invite' },
  {
    key: 'shareViewed',
    label: 'Share link viewed',
    description: 'When someone views your shared recording',
  },
  {
    key: 'weeklyDigest',
    label: 'Weekly digest',
    description: 'Weekly summary of your recording activity',
  },
];

const MOCK_SESSIONS = [
  {
    id: '1',
    device: 'Chrome on macOS',
    location: 'San Francisco, US',
    last: '2 minutes ago',
    current: true,
    icon: <Monitor className="h-4 w-4" />,
  },
  {
    id: '2',
    device: 'Safari on iPhone',
    location: 'San Francisco, US',
    last: '3 days ago',
    current: false,
    icon: <Smartphone className="h-4 w-4" />,
  },
];

type SettingsSection =
  | 'profile'
  | 'preferences'
  | 'recording'
  | 'integrations'
  | 'shortcuts'
  | 'billing'
  | 'workspace';

interface SidebarItem {
  id: SettingsSection;
  label: string;
  icon: React.ReactNode;
  description?: string;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  {
    id: 'profile',
    label: 'Profile',
    icon: <User className="h-4 w-4" />,
    description: 'Your personal information',
  },
  {
    id: 'preferences',
    label: 'Preferences',
    icon: <Sliders className="h-4 w-4" />,
    description: 'App preferences',
  },
  {
    id: 'recording',
    label: 'Recording',
    icon: <Video className="h-4 w-4" />,
    description: 'Recording settings',
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: <Zap className="h-4 w-4" />,
    description: 'Connected apps',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: <Key className="h-4 w-4" />,
    description: 'Keyboard shortcuts',
  },
  {
    id: 'billing',
    label: 'Billing',
    icon: <CreditCard className="h-4 w-4" />,
    description: 'Manage subscription',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: <Users className="h-4 w-4" />,
    description: 'Workspace settings',
  },
];

// ─── Toggle component ─────────────────────────────────────────────────────────

function PremiumSwitch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 cursor-pointer"
      style={{
        background: checked
          ? 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)'
          : 'rgba(255,255,255,0.08)',
        border: checked ? 'none' : '1px solid rgba(255,255,255,0.1)',
        boxShadow: checked ? '0 2px 8px rgba(124,58,237,0.4)' : 'none',
      }}
    >
      <Switch.Thumb
        className="block rounded-full bg-white shadow-sm transition-transform duration-200 data-[state=checked]:translate-x-5 translate-x-1"
        style={{ width: 16, height: 16 }}
      />
    </Switch.Root>
  );
}

// ─── Content sections ─────────────────────────────────────────────────────────

function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl p-6 ${className ?? ''}`}
      style={{
        background:
          'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
        border: '1px solid rgba(255,255,255,0.07)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold text-slate-200 mb-5">{children}</h2>;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SettingsPage() {
  const {
    user,
    updateProfile,
    updateProfilePending,
    changePassword,
    changePasswordPending,
    logout,
  } = useAuth();

  const avatarRef = useRef<HTMLInputElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile');

  // Profile form
  const [name, setName] = useState(user?.name ?? '');
  const [email] = useState(user?.email ?? '');

  // Security form
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confPw, setConfPw] = useState('');

  // Prefs
  const [recordingPrefs, setRecordingPrefs] = useState<Record<string, boolean>>(
    Object.fromEntries(RECORDING_PREFS.map((p) => [p.key, true])),
  );
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>(
    Object.fromEntries(NOTIFICATION_PREFS.map((p) => [p.key, true])),
  );

  // API keys
  const [apiKeys, setApiKeys] = useState<
    Array<{ id: string; name: string; key: string; created: string }>
  >([]);
  const [apiKeyName, setApiKeyName] = useState('');
  const [newKeyModal, setNewKeyModal] = useState(false);

  // Delete account
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');

  // Handlers
  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateProfile({ name });
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { url } = await api.uploadAvatar(file);
      await updateProfile({ avatar: url });
    } catch {
      toast.error('Failed to upload avatar');
    }
  };

  const handlePasswordSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPw !== confPw) {
      toast.error('Passwords do not match');
      return;
    }
    if (newPw.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    await changePassword({ currentPassword: curPw, newPassword: newPw });
    setCurPw('');
    setNewPw('');
    setConfPw('');
  };

  const handleGenerateKey = () => {
    if (!apiKeyName.trim()) return;
    setApiKeys((k) => [
      ...k,
      {
        id: Math.random().toString(36).slice(2),
        name: apiKeyName,
        key: `jam_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
        created: new Date().toISOString(),
      },
    ]);
    setApiKeyName('');
    setNewKeyModal(false);
    toast.success('API key generated');
  };

  const handleDeleteAccount = async () => {
    if (deleteInput !== user?.email) {
      toast.error('Email does not match');
      return;
    }
    await api.deleteAccount();
    logout();
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Render content panels
  // ──────────────────────────────────────────────────────────────────────────

  const renderContent = () => {
    switch (activeSection) {
      case 'profile':
        return (
          <div className="space-y-5">
            {/* Profile info */}
            <SectionCard>
              <SectionTitle>Profile Information</SectionTitle>
              {/* Avatar */}
              <div className="flex items-center gap-5 mb-6">
                <div className="relative flex-shrink-0">
                  <div
                    className="h-20 w-20 rounded-2xl overflow-hidden flex items-center justify-center text-white text-2xl font-bold"
                    style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #4c1d95 100%)' }}
                  >
                    {user?.avatar ? (
                      <img
                        src={user.avatar}
                        alt={user.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      getInitials(user?.name ?? 'U')
                    )}
                  </div>
                  {/* Online indicator */}
                  <div
                    className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full"
                    style={{ background: '#22c55e', border: '2px solid #060816' }}
                  />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-200">{user?.name ?? 'User'}</p>
                  <p className="text-xs text-slate-500 mt-0.5 mb-3">{user?.email}</p>
                  <button
                    onClick={() => avatarRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 transition-colors hover:text-slate-100"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    <Upload className="h-3 w-3" />
                    Update photo
                  </button>
                  <p className="text-[11px] text-slate-600 mt-1">JPG, PNG or GIF. Max 5 MB.</p>
                  <input
                    ref={avatarRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleAvatarChange}
                  />
                </div>
              </div>

              <form onSubmit={handleProfileSave} className="space-y-4">
                <Input
                  label="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                />
                <Input
                  label="Email address"
                  type="email"
                  value={email}
                  placeholder="you@example.com"
                  hint="Email changes require verification"
                  disabled
                />
                <div className="pt-1">
                  <button
                    type="submit"
                    disabled={updateProfilePending}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{
                      background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
                      boxShadow: '0 4px 14px rgba(124,58,237,0.35)',
                    }}
                  >
                    <Check className="h-4 w-4" />
                    {updateProfilePending ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            </SectionCard>

            {/* Change password */}
            <SectionCard>
              <SectionTitle>Change Password</SectionTitle>
              <form onSubmit={handlePasswordSave} className="space-y-4">
                <Input
                  label="Current password"
                  type="password"
                  value={curPw}
                  onChange={(e) => setCurPw(e.target.value)}
                  placeholder="••••••••"
                />
                <Input
                  label="New password"
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="••••••••"
                  hint="At least 8 characters"
                />
                <Input
                  label="Confirm new password"
                  type="password"
                  value={confPw}
                  onChange={(e) => setConfPw(e.target.value)}
                  placeholder="••••••••"
                />
                <Button type="submit" loading={changePasswordPending}>
                  Update password
                </Button>
              </form>
            </SectionCard>

            {/* Active sessions */}
            <SectionCard>
              <div className="flex items-center justify-between mb-5">
                <SectionTitle>Active Sessions</SectionTitle>
                <Shield className="h-4 w-4 text-slate-500" />
              </div>
              <div className="space-y-2">
                {MOCK_SESSIONS.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-3 p-3.5 rounded-xl"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.07)',
                    }}
                  >
                    <div
                      className="p-2 rounded-lg text-slate-400 flex-shrink-0"
                      style={{ background: 'rgba(255,255,255,0.06)' }}
                    >
                      {s.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-200">{s.device}</p>
                        {s.current && (
                          <Badge variant="success" size="sm">
                            Current
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">
                        {s.location} · {s.last}
                      </p>
                    </div>
                    {!s.current && (
                      <Button variant="ghost" size="xs" className="text-red-400 hover:text-red-300">
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* Danger zone */}
            <div
              className="rounded-2xl p-6"
              style={{
                background: 'rgba(239,68,68,0.04)',
                border: '1px solid rgba(239,68,68,0.2)',
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-4 w-4 text-red-400" />
                <h2 className="text-sm font-semibold text-red-400">Danger Zone</h2>
              </div>
              <p className="text-sm text-slate-400 mb-4">
                Permanently delete your account and all associated data. This cannot be undone.
              </p>
              <div className="flex gap-3 flex-wrap">
                <button
                  onClick={() => logout()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-red-400 transition-colors hover:text-red-300"
                  style={{
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.2)',
                  }}
                >
                  Sign out from all devices
                </button>
                <button
                  onClick={() => setDeleteConfirm(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors"
                  style={{
                    background: 'rgba(239,68,68,0.7)',
                    border: '1px solid rgba(239,68,68,0.5)',
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete account
                </button>
              </div>
            </div>
          </div>
        );

      case 'preferences':
        return (
          <div className="space-y-5">
            <SectionCard>
              <SectionTitle>Notification Preferences</SectionTitle>
              <div className="space-y-1">
                {NOTIFICATION_PREFS.map((pref, idx) => (
                  <div
                    key={pref.key}
                    className="flex items-center justify-between py-4"
                    style={
                      idx < NOTIFICATION_PREFS.length - 1
                        ? { borderBottom: '1px solid rgba(255,255,255,0.06)' }
                        : {}
                    }
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-200">{pref.label}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{pref.description}</p>
                    </div>
                    <PremiumSwitch
                      checked={notifPrefs[pref.key] ?? true}
                      onCheckedChange={(v) => setNotifPrefs((p) => ({ ...p, [pref.key]: v }))}
                    />
                  </div>
                ))}
              </div>
              <div className="pt-4">
                <Button onClick={() => toast.success('Preferences saved')}>Save Preferences</Button>
              </div>
            </SectionCard>
          </div>
        );

      case 'recording':
        return (
          <div className="space-y-5">
            <SectionCard>
              <SectionTitle>Recording Settings</SectionTitle>
              <div className="space-y-1">
                {RECORDING_PREFS.map((pref, idx) => (
                  <div
                    key={pref.key}
                    className="flex items-center justify-between py-4"
                    style={
                      idx < RECORDING_PREFS.length - 1
                        ? { borderBottom: '1px solid rgba(255,255,255,0.06)' }
                        : {}
                    }
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className="mt-0.5 p-2 rounded-lg flex-shrink-0"
                        style={{
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.07)',
                        }}
                      >
                        {pref.icon}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-200">{pref.label}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{pref.description}</p>
                      </div>
                    </div>
                    <div className="flex-shrink-0 ml-4">
                      <PremiumSwitch
                        checked={recordingPrefs[pref.key] ?? true}
                        onCheckedChange={(v) => setRecordingPrefs((p) => ({ ...p, [pref.key]: v }))}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="pt-4">
                <Button onClick={() => toast.success('Recording settings saved')}>
                  Save Settings
                </Button>
              </div>
            </SectionCard>
          </div>
        );

      case 'integrations':
        return (
          <div className="space-y-5">
            <SectionCard>
              <SectionTitle>API Keys</SectionTitle>
              <p className="text-sm text-slate-500 -mt-2 mb-5">
                Use API keys to authenticate with the SnapTrace API
              </p>
              <div className="flex justify-end mb-4">
                <button
                  onClick={() => setNewKeyModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-300 transition-colors hover:text-slate-100"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.09)',
                  }}
                >
                  <Key className="h-3.5 w-3.5" />
                  Generate key
                </button>
              </div>

              {apiKeys.length > 0 ? (
                <div className="space-y-2">
                  {apiKeys.map((k) => (
                    <div
                      key={k.id}
                      className="flex items-center gap-3 p-3.5 rounded-xl"
                      style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.07)',
                      }}
                    >
                      <Key className="h-4 w-4 text-slate-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-200">{k.name}</p>
                        <p className="text-xs font-mono text-slate-500 truncate">
                          {k.key.slice(0, 32)}…
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-red-400 hover:text-red-300 flex-shrink-0"
                        onClick={() => {
                          setApiKeys((keys) => keys.filter((ak) => ak.id !== k.id));
                          toast.success('API key revoked');
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <div
                    className="h-12 w-12 rounded-xl flex items-center justify-center mb-3"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.07)',
                    }}
                  >
                    <Key className="h-5 w-5 text-slate-500" />
                  </div>
                  <p className="text-sm text-slate-500">No API keys yet</p>
                  <p className="text-xs text-slate-600 mt-1">Generate a key to access the API</p>
                </div>
              )}
            </SectionCard>
          </div>
        );

      case 'shortcuts':
        return (
          <div className="space-y-5">
            <SectionCard>
              <SectionTitle>Keyboard Shortcuts</SectionTitle>
              <div className="space-y-3">
                {[
                  { action: 'Start / Stop recording', keys: ['⌘', 'Shift', 'R'] },
                  { action: 'Pause recording', keys: ['⌘', 'Shift', 'P'] },
                  { action: 'Take screenshot', keys: ['⌘', 'Shift', 'S'] },
                  { action: 'Open library', keys: ['⌘', 'Shift', 'L'] },
                  { action: 'Copy last link', keys: ['⌘', 'Shift', 'C'] },
                ].map((sc, idx, arr) => (
                  <div
                    key={sc.action}
                    className="flex items-center justify-between py-3"
                    style={
                      idx < arr.length - 1
                        ? { borderBottom: '1px solid rgba(255,255,255,0.06)' }
                        : {}
                    }
                  >
                    <p className="text-sm text-slate-300">{sc.action}</p>
                    <div className="flex items-center gap-1">
                      {sc.keys.map((k) => (
                        <kbd
                          key={k}
                          className="px-2 py-0.5 rounded text-xs font-mono text-slate-300"
                          style={{
                            background: 'rgba(255,255,255,0.07)',
                            border: '1px solid rgba(255,255,255,0.12)',
                          }}
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>
        );

      case 'billing':
        return (
          <div className="space-y-5">
            <SectionCard>
              <SectionTitle>Current Plan</SectionTitle>
              <div
                className="flex items-center justify-between p-4 rounded-xl mb-5"
                style={{
                  background: 'rgba(139,92,246,0.08)',
                  border: '1px solid rgba(139,92,246,0.2)',
                }}
              >
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg font-bold text-slate-100">Pro Plan</span>
                    <Badge variant="purple" size="sm">
                      Active
                    </Badge>
                  </div>
                  <p className="text-sm text-slate-400">$12/month · Renews June 16, 2026</p>
                </div>
                <button
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-px"
                  style={{
                    background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
                    boxShadow: '0 4px 14px rgba(124,58,237,0.35)',
                  }}
                >
                  Upgrade
                </button>
              </div>
              <div className="space-y-3">
                {[
                  { label: 'Recordings', used: '142', limit: 'Unlimited' },
                  { label: 'Storage', used: '2.4 GB', limit: '5 GB' },
                  { label: 'Team members', used: '1', limit: '5' },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between py-2"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <span className="text-sm text-slate-400">{item.label}</span>
                    <span className="text-sm font-medium text-slate-200">
                      {item.used} <span className="text-slate-500 font-normal">/ {item.limit}</span>
                    </span>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>
        );

      case 'workspace':
        return (
          <div className="space-y-5">
            <SectionCard>
              <SectionTitle>Workspace Settings</SectionTitle>
              <div className="space-y-4">
                <Input
                  label="Workspace name"
                  defaultValue="My Workspace"
                  placeholder="Enter workspace name"
                />
                <Input
                  label="Workspace slug"
                  defaultValue="my-workspace"
                  placeholder="workspace-slug"
                  hint="Used in your workspace URL"
                />
                <Button onClick={() => toast.success('Workspace updated')}>Save workspace</Button>
              </div>
            </SectionCard>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      {/* Page header */}
      <div className="mb-7">
        <h1 className="text-2xl font-bold text-slate-50 tracking-tight">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">Manage your account, preferences and billing</p>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-6">
        {/* Sidebar navigation */}
        <aside className="flex-shrink-0 w-56">
          <nav
            className="rounded-2xl overflow-hidden"
            style={{
              background:
                'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            <div className="p-3 space-y-0.5">
              {SIDEBAR_ITEMS.map((item) => {
                const isActive = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-150"
                    style={{
                      background: isActive ? 'rgba(124,58,237,0.15)' : 'transparent',
                      border: isActive ? '1px solid rgba(124,58,237,0.2)' : '1px solid transparent',
                    }}
                  >
                    <span
                      className={isActive ? 'text-violet-400' : 'text-slate-500'}
                      style={{ transition: 'color 150ms' }}
                    >
                      {item.icon}
                    </span>
                    <span
                      className={`text-sm font-medium flex-1 ${isActive ? 'text-violet-300' : 'text-slate-400'}`}
                      style={{ transition: 'color 150ms' }}
                    >
                      {item.label}
                    </span>
                    {isActive && (
                      <ChevronRight className="h-3.5 w-3.5 text-violet-400 flex-shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </nav>
        </aside>

        {/* Content panel */}
        <div className="flex-1 min-w-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeSection}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.18 }}
            >
              {renderContent()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Generate API key modal */}
      <Modal
        open={newKeyModal}
        onClose={() => setNewKeyModal(false)}
        title="Generate API key"
        size="sm"
      >
        <div className="space-y-4">
          <Input
            label="Key name"
            value={apiKeyName}
            onChange={(e) => setApiKeyName(e.target.value)}
            placeholder="e.g., Production app"
          />
        </div>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setNewKeyModal(false)}>
            Cancel
          </Button>
          <Button onClick={handleGenerateKey} disabled={!apiKeyName.trim()}>
            Generate
          </Button>
        </ModalFooter>
      </Modal>

      {/* Delete account modal */}
      <Modal
        open={deleteConfirm}
        onClose={() => {
          setDeleteConfirm(false);
          setDeleteInput('');
        }}
        title="Delete account"
        description="This action cannot be undone. Type your email to confirm."
        size="sm"
      >
        <div className="space-y-4 mt-4">
          <Input
            value={deleteInput}
            onChange={(e) => setDeleteInput(e.target.value)}
            placeholder={user?.email ?? 'your@email.com'}
          />
        </div>
        <ModalFooter>
          <Button
            variant="secondary"
            onClick={() => {
              setDeleteConfirm(false);
              setDeleteInput('');
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={deleteInput !== user?.email}
            onClick={handleDeleteAccount}
          >
            Delete account
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
