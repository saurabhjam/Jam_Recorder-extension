import { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Camera, Mic, Link, Timer, AlertTriangle, Check, User } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { useSettingsStore } from '@/store/settings.store';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { InstanceBadge } from '@/components/ui/InstanceBadge';
import { cn, blobToDataUrl } from '@/utils';
import { STORAGE_KEYS } from '@/types';
import { API_BASE_URL } from '@/config';

/** Best-effort push of a new profile photo to the portal. The local avatar is
 *  updated instantly regardless; this keeps the server copy in sync. */
async function uploadProfilePhoto(file: File): Promise<void> {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
    const token = (r[STORAGE_KEYS.AUTH_TOKENS] as { accessToken?: string } | undefined)
      ?.accessToken;
    if (!token) return;
    const form = new FormData();
    form.append('file', file);
    await fetch(`${API_BASE_URL}/v1/data/photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    /* best-effort — the local avatar already updated */
  }
}

interface SettingsViewProps {
  onBack: () => void;
}

const CONTAINER_VARIANTS = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0.05 },
  },
};

const ITEM_VARIANTS = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 380, damping: 28 } },
};

export function SettingsView({ onBack }: SettingsViewProps) {
  const { user, logout, updateProfile } = useAuthStore();
  const { settings, updateSettings, toggleMic } = useSettingsStore();

  const [name, setName] = useState(user?.name ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSaving(true);
    try {
      // Persist the new name to the store + storage so it updates everywhere in
      // the extension (footer, avatars, settings) immediately.
      await updateProfile({ name: trimmed });
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file || !file.type.startsWith('image/')) return;
    // Show the new photo instantly across the extension…
    const dataUrl = await blobToDataUrl(file);
    await updateProfile({ avatar: dataUrl });
    // …then sync it to the portal in the background.
    void uploadProfilePhoto(file);
  };

  const handleSignOutAll = async () => {
    await logout();
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-dark-950">
      {/* ─── Header ─── */}
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-3 px-4 pt-3.5 pb-3 shrink-0 border-b border-white/6"
      >
        <button
          onClick={onBack}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-dark-400 hover:text-white hover:bg-white/8 transition-all shrink-0"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-sm font-bold text-white">Settings</h1>
        <InstanceBadge size={14} className="ml-auto" />
      </motion.div>

      {/* ─── Scrollable Content ─── */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin px-4 pb-4">
        <motion.div
          variants={CONTAINER_VARIANTS}
          initial="hidden"
          animate="show"
          className="flex flex-col gap-5 pt-4"
        >
          {/* ─── Profile Section ─── */}
          <motion.div variants={ITEM_VARIANTS}>
            <SectionLabel>Profile</SectionLabel>

            <div className="flex flex-col gap-3">
              {/* Avatar row */}
              <div className="flex items-center gap-3 p-3 bg-dark-800/50 border border-white/6 rounded-2xl">
                <div className="relative">
                  <Avatar src={user?.avatar ?? undefined} name={user?.name ?? 'User'} size="lg" />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute -bottom-0.5 -right-0.5 w-5 h-5 bg-jam-500 rounded-full flex items-center justify-center border-2 border-dark-800 hover:bg-jam-400 transition-colors"
                    title="Update photo"
                  >
                    <Camera size={9} className="text-white" />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => void handlePhotoSelected(e)}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{user?.name}</p>
                  <p className="text-xxs text-dark-400 truncate">{user?.email}</p>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xxs text-jam-400 hover:text-jam-300 transition-colors mt-0.5"
                  >
                    Update photo
                  </button>
                </div>
              </div>

              {/* Name field */}
              <Input
                label="Display Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                leftIcon={<User size={14} />}
              />

              {/* Email (read-only) */}
              <Input
                label="Email"
                value={user?.email ?? ''}
                readOnly
                disabled
                helperText="Email cannot be changed"
              />

              {/* Save button */}
              <Button
                variant="primary"
                size="sm"
                fullWidth
                loading={isSaving}
                onClick={() => void handleSave()}
                leftIcon={savedOk ? <Check size={14} /> : undefined}
                className={
                  savedOk
                    ? 'from-emerald-500 to-emerald-400 hover:from-emerald-600 hover:to-emerald-500'
                    : ''
                }
              >
                {savedOk ? 'Saved!' : 'Save Changes'}
              </Button>
            </div>
          </motion.div>

          {/* ─── Preferences Section ─── */}
          <motion.div variants={ITEM_VARIANTS}>
            <SectionLabel>Preferences</SectionLabel>
            <div className="flex flex-col gap-1.5 bg-dark-800/40 border border-white/6 rounded-2xl overflow-hidden">
              <ToggleSetting
                icon={<Mic size={14} />}
                label="Start recording with mic"
                checked={settings.micEnabled}
                onChange={() => void toggleMic()}
              />
              <ToggleSetting
                icon={<Link size={14} />}
                label="Auto copy link after upload"
                checked={settings.autoOpenShare}
                onChange={() => void updateSettings({ autoOpenShare: !settings.autoOpenShare })}
              />
              <ToggleSetting
                icon={<Timer size={14} />}
                label="Show countdown before recording"
                checked={settings.countdownEnabled}
                onChange={() =>
                  void updateSettings({ countdownEnabled: !settings.countdownEnabled })
                }
                last
              />
            </div>
          </motion.div>

          {/* ─── Danger Zone ─── */}
          <motion.div variants={ITEM_VARIANTS}>
            <SectionLabel className="text-red-400/70">Danger Zone</SectionLabel>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleSignOutAll()}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-dark-800/50 border border-white/6 hover:border-red-500/30 hover:bg-red-500/6 transition-all text-left group"
              >
                <div className="w-7 h-7 rounded-lg bg-dark-700 flex items-center justify-center shrink-0 group-hover:bg-red-500/15 transition-colors">
                  <AlertTriangle
                    size={13}
                    className="text-dark-400 group-hover:text-red-400 transition-colors"
                  />
                </div>
                <div>
                  <p className="text-xs font-medium text-dark-200 group-hover:text-red-300 transition-colors">
                    Sign out from all devices
                  </p>
                  <p className="text-xxs text-dark-500">Revoke all active sessions</p>
                </div>
              </button>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

// ─── Section Label ────────────────────────────────────────────────────────────

interface SectionLabelProps {
  children: React.ReactNode;
  className?: string;
}

function SectionLabel({ children, className }: SectionLabelProps) {
  return (
    <p
      className={cn(
        'text-xxs font-semibold uppercase tracking-widest text-dark-500 mb-2',
        className,
      )}
    >
      {children}
    </p>
  );
}

// ─── Toggle Setting ───────────────────────────────────────────────────────────

interface ToggleSettingProps {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onChange: () => void;
  last?: boolean;
}

function ToggleSetting({ icon, label, checked, onChange, last = false }: ToggleSettingProps) {
  return (
    <button
      onClick={onChange}
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-white/4 text-left w-full',
        !last && 'border-b border-white/4',
      )}
    >
      <div className="w-6 h-6 rounded-md bg-dark-700/80 flex items-center justify-center shrink-0 text-dark-300">
        {icon}
      </div>
      <span className="flex-1 text-xs text-dark-200">{label}</span>

      {/* Toggle switch */}
      <div
        className={cn(
          'w-8 h-4.5 rounded-full relative transition-all duration-200 shrink-0',
          checked ? 'bg-jam-500' : 'bg-dark-700',
        )}
        style={{ height: '18px', width: '32px' }}
      >
        <motion.div
          animate={{ x: checked ? 14 : 2 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm"
        />
      </div>
    </button>
  );
}
