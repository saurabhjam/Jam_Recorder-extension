import React, { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
} from 'lucide-react';
import toast from 'react-hot-toast';
import { motion } from 'framer-motion';
import { Button } from '@components/ui/Button';
import { Input } from '@components/ui/Input';
import { Badge } from '@components/ui/Badge';
import { Modal, ModalFooter } from '@components/ui/Modal';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/Tabs';
import { useAuth } from '@hooks/useAuth';
import { api } from '@services/api';
import { getInitials } from '@utils/index';
import * as Switch from '@radix-ui/react-switch';

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

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confPw, setConfPw] = useState('');
  const [prefs, setPrefs] = useState<Record<string, boolean>>(
    Object.fromEntries(NOTIFICATION_PREFS.map((p) => [p.key, true])),
  );
  const [apiKeys, setApiKeys] = useState<
    Array<{ id: string; name: string; key: string; created: string }>
  >([]);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [apiKeyName, setApiKeyName] = useState('');
  const [newKeyModal, setNewKeyModal] = useState(false);

  // ── Profile save ──────────────────────────────────────────────────────────
  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateProfile({ name });
  };

  // ── Avatar upload ─────────────────────────────────────────────────────────
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

  // ── Password change ───────────────────────────────────────────────────────
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

  // ── Generate API key (mock) ───────────────────────────────────────────────
  const handleGenerateKey = () => {
    if (!apiKeyName.trim()) return;
    const newKey = {
      id: Math.random().toString(36).slice(2),
      name: apiKeyName,
      key: `jam_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
      created: new Date().toISOString(),
    };
    setApiKeys((k) => [...k, newKey]);
    setApiKeyName('');
    setNewKeyModal(false);
    toast.success('API key generated');
  };

  // ── Delete account ────────────────────────────────────────────────────────
  const handleDeleteAccount = async () => {
    if (deleteInput !== user?.email) {
      toast.error('Email does not match');
      return;
    }
    await api.deleteAccount();
    logout();
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage your account preferences</p>
      </div>

      <Tabs defaultValue="profile">
        <TabsList variant="underline">
          <TabsTrigger value="profile" variant="underline">
            <User className="h-3.5 w-3.5" /> Profile
          </TabsTrigger>
          <TabsTrigger value="security" variant="underline">
            <Lock className="h-3.5 w-3.5" /> Security
          </TabsTrigger>
          <TabsTrigger value="notifications" variant="underline">
            <Bell className="h-3.5 w-3.5" /> Notifications
          </TabsTrigger>
          <TabsTrigger value="api" variant="underline">
            <Key className="h-3.5 w-3.5" /> API Keys
          </TabsTrigger>
          <TabsTrigger value="danger" variant="underline">
            <Trash2 className="h-3.5 w-3.5" /> Danger
          </TabsTrigger>
        </TabsList>

        {/* ── Profile ── */}
        <TabsContent value="profile" className="pt-6">
          <div className="card p-6 space-y-6">
            <h2 className="text-base font-semibold text-gray-200">Profile information</h2>

            {/* Avatar */}
            <div className="flex items-center gap-4">
              <div className="relative h-16 w-16 rounded-full overflow-hidden bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center text-white text-xl font-bold flex-shrink-0">
                {user?.avatar ? (
                  <img src={user.avatar} alt={user.name} className="w-full h-full object-cover" />
                ) : (
                  getInitials(user?.name ?? 'U')
                )}
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<Upload className="h-3.5 w-3.5" />}
                  onClick={() => avatarRef.current?.click()}
                >
                  Upload photo
                </Button>
                <p className="text-xs text-gray-500 mt-1">JPG, PNG or GIF. Max 5 MB.</p>
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
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                hint="Email changes require verification"
                disabled
              />
              <div className="pt-2">
                <Button
                  type="submit"
                  loading={updateProfilePending}
                  leftIcon={<Check className="h-4 w-4" />}
                >
                  Save changes
                </Button>
              </div>
            </form>
          </div>
        </TabsContent>

        {/* ── Security ── */}
        <TabsContent value="security" className="pt-6 space-y-6">
          {/* Password */}
          <div className="card p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-200">Change password</h2>
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
          </div>

          {/* Active sessions */}
          <div className="card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-200">Active sessions</h2>
              <Shield className="h-4 w-4 text-gray-500" />
            </div>
            <div className="space-y-3">
              {MOCK_SESSIONS.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 p-3 rounded-xl bg-gray-800/40 border border-white/[0.05]"
                >
                  <div className="p-2 rounded-lg bg-gray-700/50 text-gray-400 flex-shrink-0">
                    {s.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-200">{s.device}</p>
                      {s.current && (
                        <Badge variant="success" size="sm">
                          Current
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">
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
          </div>
        </TabsContent>

        {/* ── Notifications ── */}
        <TabsContent value="notifications" className="pt-6">
          <div className="card p-6 space-y-5">
            <h2 className="text-base font-semibold text-gray-200">Notification preferences</h2>
            <div className="space-y-4 divide-y divide-white/[0.05]">
              {NOTIFICATION_PREFS.map((pref) => (
                <div key={pref.key} className="flex items-center justify-between pt-4 first:pt-0">
                  <div>
                    <p className="text-sm font-medium text-gray-200">{pref.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{pref.description}</p>
                  </div>
                  <Switch.Root
                    checked={prefs[pref.key]}
                    onCheckedChange={(v) => setPrefs((p) => ({ ...p, [pref.key]: v }))}
                    className={`w-10 h-6 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 ${prefs[pref.key] ? 'bg-violet-600' : 'bg-gray-700'}`}
                  >
                    <Switch.Thumb className="block w-4 h-4 bg-white rounded-full shadow transition-transform data-[state=checked]:translate-x-5 translate-x-1" />
                  </Switch.Root>
                </div>
              ))}
            </div>
            <Button onClick={() => toast.success('Preferences saved')}>Save preferences</Button>
          </div>
        </TabsContent>

        {/* ── API Keys ── */}
        <TabsContent value="api" className="pt-6">
          <div className="card p-6 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-200">API Keys</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Use API keys to authenticate with the SnapTrace API
                </p>
              </div>
              <Button
                size="sm"
                leftIcon={<Key className="h-3.5 w-3.5" />}
                onClick={() => setNewKeyModal(true)}
              >
                Generate key
              </Button>
            </div>

            {apiKeys.length > 0 ? (
              <div className="space-y-2">
                {apiKeys.map((k) => (
                  <div
                    key={k.id}
                    className="flex items-center gap-3 p-3 rounded-xl bg-gray-800/40 border border-white/[0.05]"
                  >
                    <Key className="h-4 w-4 text-gray-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-200">{k.name}</p>
                      <p className="text-xs font-mono text-gray-500 truncate">
                        {k.key.slice(0, 30)}…
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
              <div className="text-center py-8 text-gray-600">
                <Key className="h-8 w-8 mx-auto mb-2" />
                <p className="text-sm">No API keys yet</p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── Danger zone ── */}
        <TabsContent value="danger" className="pt-6">
          <div className="card border-red-500/20 p-6 space-y-4">
            <div className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="h-5 w-5" />
              <h2 className="text-base font-semibold">Danger zone</h2>
            </div>
            <p className="text-sm text-gray-400">
              Deleting your account is permanent. All your recordings, data, and settings will be
              permanently removed.
            </p>
            <Button
              variant="danger"
              leftIcon={<Trash2 className="h-4 w-4" />}
              onClick={() => setDeleteConfirm(true)}
            >
              Delete my account
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {/* Generate key modal */}
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
