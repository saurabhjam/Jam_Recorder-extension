import React, { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Monitor,
  Camera,
  Heart,
  Trash2,
  Settings,
  Users,
  LogOut,
  ChevronDown,
  Menu,
  X,
  Zap,
  Bell,
  Search,
  HardDrive,
  User,
  CreditCard,
} from 'lucide-react';
import {
  Dropdown,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
} from '@components/ui/Dropdown';
import { Badge } from '@components/ui/Badge';
import { cn, getInitials } from '@utils/index';
import { useAuth } from '@hooks/useAuth';
import { useUIStore } from '@store/ui.store';
import { useQuery } from '@tanstack/react-query';
import { api } from '@services/api';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Recordings', href: '/library', icon: <Monitor className="h-4 w-4" /> },
  { label: 'Screenshots', href: '/screenshots', icon: <Camera className="h-4 w-4" /> },
  { label: 'Favorites', href: '/favorites', icon: <Heart className="h-4 w-4" /> },
  { label: 'Trash', href: '/trash', icon: <Trash2 className="h-4 w-4" /> },
];

const NAV_BOTTOM: NavItem[] = [
  { label: 'Settings', href: '/settings', icon: <Settings className="h-4 w-4" /> },
  { label: 'Teams', href: '/team', icon: <Users className="h-4 w-4" /> },
];

const PLAN_BADGE: Record<
  string,
  { label: string; variant: 'default' | 'success' | 'purple' | 'warning' }
> = {
  FREE: { label: 'Free', variant: 'default' },
  PRO: { label: 'Pro', variant: 'purple' },
  TEAM: { label: 'Team', variant: 'success' },
  ENTERPRISE: { label: 'Enterprise', variant: 'warning' },
};

interface DashboardLayoutProps {
  children: React.ReactNode;
  title?: string;
}

export function DashboardLayout({ children, title }: DashboardLayoutProps) {
  const { user, logout } = useAuth();
  const { sidebarOpen, toggleSidebar } = useUIStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.getNotifications.bind(api),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const unreadCount = notifications?.filter((n) => !n.isRead).length ?? 0;

  const plan = 'PRO';
  const planInfo = PLAN_BADGE[plan] ?? PLAN_BADGE.FREE;

  // Mock storage usage (50%)
  const storageUsed = 50;

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: '#060816' }}>
      {/* Mobile overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed lg:relative z-50 flex flex-col h-full transition-all duration-300 glass-sidebar',
          sidebarOpen ? 'w-60' : 'w-0 lg:w-[68px] overflow-hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Logo */}
        <div
          className="flex h-16 items-center px-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.055)' }}
        >
          <Link to="/dashboard" className="flex items-center gap-3 min-w-0">
            {/* Purple gradient icon */}
            <div
              className="flex-shrink-0 h-9 w-9 rounded-xl flex items-center justify-center shadow-lg"
              style={{
                background: 'linear-gradient(135deg, #7c3aed 0%, #4c1d95 100%)',
                boxShadow: '0 4px 14px rgba(124,58,237,0.4)',
              }}
            >
              <Zap className="h-4.5 w-4.5 text-white" />
            </div>
            {sidebarOpen && (
              <span
                className="font-bold text-base tracking-tight truncate"
                style={{
                  background: 'linear-gradient(135deg, #c4b5fd 0%, #8b5cf6 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                SnapTrace
              </span>
            )}
          </Link>
        </div>

        {/* Nav - main */}
        <nav className="flex-1 py-4 px-2.5 space-y-0.5 overflow-y-auto no-scrollbar">
          {/* Section label */}
          {sidebarOpen && (
            <p className="px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-2">
              Library
            </p>
          )}
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                cn('nav-item', isActive && 'active', !sidebarOpen && 'justify-center px-0 py-3')
              }
              title={!sidebarOpen ? item.label : undefined}
            >
              <span className="flex-shrink-0 nav-icon">{item.icon}</span>
              {sidebarOpen && <span className="truncate">{item.label}</span>}
            </NavLink>
          ))}

          {/* Divider */}
          <div
            className="my-3 mx-2"
            style={{ height: '1px', background: 'rgba(255,255,255,0.055)' }}
          />

          {sidebarOpen && (
            <p className="px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-2">
              Account
            </p>
          )}
          {NAV_BOTTOM.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                cn('nav-item', isActive && 'active', !sidebarOpen && 'justify-center px-0 py-3')
              }
              title={!sidebarOpen ? item.label : undefined}
            >
              <span className="flex-shrink-0 nav-icon">{item.icon}</span>
              {sidebarOpen && <span className="truncate">{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Storage bar */}
        {sidebarOpen && (
          <div className="px-3 pb-3">
            <div
              className="rounded-xl p-3 space-y-2"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <div className="flex items-center gap-2">
                <HardDrive className="h-3.5 w-3.5 text-violet-400 flex-shrink-0" />
                <span className="text-xs font-medium text-slate-300">Storage</span>
                <span className="ml-auto text-xs text-slate-500">{storageUsed}%</span>
              </div>
              <div className="h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div
                  className="h-1.5 rounded-full"
                  style={{
                    width: `${storageUsed}%`,
                    background: 'linear-gradient(90deg, #7c3aed, #a855f7)',
                  }}
                />
              </div>
              <p className="text-[10px] text-slate-600">2.4 GB of 5 GB used</p>
            </div>
          </div>
        )}

        {/* User section */}
        {user && (
          <div
            className={cn('p-3', !sidebarOpen && 'p-2')}
            style={{ borderTop: '1px solid rgba(255,255,255,0.055)' }}
          >
            {sidebarOpen ? (
              <div className="flex items-center gap-2.5 p-1">
                <Avatar name={user.name} avatarUrl={user.avatar} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-200 truncate">{user.name}</p>
                  <div className="mt-0.5">
                    <Badge variant={planInfo.variant} size="sm">
                      {planInfo.label}
                    </Badge>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex justify-center">
                <Avatar name={user.name} avatarUrl={user.avatar} size="sm" />
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header
          className="flex h-16 items-center gap-4 px-6 flex-shrink-0"
          style={{
            background: 'rgba(6,8,22,0.85)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderBottom: '1px solid rgba(255,255,255,0.055)',
          }}
        >
          {/* Sidebar toggle */}
          <button
            onClick={() => {
              toggleSidebar();
              setMobileOpen(!mobileOpen);
            }}
            className="text-slate-500 hover:text-slate-300 transition-colors p-1.5 rounded-lg hover:bg-white/[0.06]"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>

          {/* Page title */}
          {title && (
            <h1 className="text-base font-semibold text-slate-100 hidden md:block">{title}</h1>
          )}

          <div className="flex-1" />

          {/* Search */}
          <div className="relative hidden md:flex items-center">
            <Search className="absolute left-3 h-4 w-4 text-slate-500 pointer-events-none" />
            <input
              type="search"
              placeholder="Search recordings..."
              className="pl-9 pr-4 h-9 w-60 text-sm rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            />
          </div>

          {/* Notifications */}
          <button
            className="relative p-2 rounded-xl text-slate-500 hover:text-slate-300 transition-colors"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
            onClick={() => navigate('/settings')}
          >
            <Bell className="h-4.5 w-4.5" />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-[9px] font-bold text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {/* User menu */}
          {user && (
            <Dropdown>
              <DropdownTrigger asChild>
                <button className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.06]">
                  <Avatar name={user.name} avatarUrl={user.avatar} size="sm" />
                  <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                </button>
              </DropdownTrigger>
              <DropdownContent align="end" className="w-52">
                <div
                  className="px-2.5 py-2 mb-1"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
                >
                  <p className="text-sm font-medium text-slate-200 truncate">{user.name}</p>
                  <p className="text-xs text-slate-500 truncate">{user.email}</p>
                </div>
                <DropdownItem
                  icon={<User className="h-3.5 w-3.5" />}
                  onSelect={() => navigate('/settings')}
                >
                  Profile
                </DropdownItem>
                <DropdownItem
                  icon={<CreditCard className="h-3.5 w-3.5" />}
                  onSelect={() => navigate('/billing')}
                >
                  Billing
                </DropdownItem>
                <DropdownSeparator />
                <DropdownItem
                  icon={<LogOut className="h-3.5 w-3.5" />}
                  destructive
                  onSelect={logout}
                >
                  Sign out
                </DropdownItem>
              </DropdownContent>
            </Dropdown>
          )}
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto" style={{ backgroundColor: '#060816' }}>
          <div className="p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

// Avatar component
interface AvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
}

function Avatar({ name, avatarUrl, size = 'md' }: AvatarProps) {
  const sizes = {
    sm: 'h-7 w-7 text-xs',
    md: 'h-8 w-8 text-sm',
    lg: 'h-10 w-10 text-base',
  };
  return (
    <div
      className={cn(
        'rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center font-semibold text-white',
        sizes[size],
      )}
      style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #4c1d95 100%)' }}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} className="w-full h-full object-cover" />
      ) : (
        getInitials(name)
      )}
    </div>
  );
}
