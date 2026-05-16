import React, { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  Library,
  Users,
  BarChart3,
  Settings,
  CreditCard,
  Bell,
  Search,
  LogOut,
  User,
  ChevronDown,
  Menu,
  X,
  Zap,
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
  { label: 'Dashboard', href: '/dashboard', icon: <LayoutDashboard className="h-4.5 w-4.5" /> },
  { label: 'Library', href: '/library', icon: <Library className="h-4.5 w-4.5" /> },
  { label: 'Team', href: '/team', icon: <Users className="h-4.5 w-4.5" /> },
  { label: 'Analytics', href: '/analytics', icon: <BarChart3 className="h-4.5 w-4.5" /> },
  { label: 'Settings', href: '/settings', icon: <Settings className="h-4.5 w-4.5" /> },
  { label: 'Billing', href: '/billing', icon: <CreditCard className="h-4.5 w-4.5" /> },
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

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      {/* ── Mobile overlay ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside
        className={cn(
          'fixed lg:relative z-50 flex flex-col h-full transition-all duration-200 glass-sidebar',
          sidebarOpen ? 'w-60' : 'w-0 lg:w-16 overflow-hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center px-4 border-b border-white/[0.06] flex-shrink-0">
          <Link to="/dashboard" className="flex items-center gap-2.5 min-w-0">
            <div className="flex-shrink-0 h-8 w-8 rounded-xl bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <Zap className="h-4 w-4 text-white" />
            </div>
            {sidebarOpen && (
              <span className="font-bold text-lg tracking-tight truncate bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent">
                SnapTrace
              </span>
            )}
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 px-2 space-y-0.5 overflow-y-auto no-scrollbar">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                cn('nav-item', isActive && 'active', !sidebarOpen && 'justify-center px-0')
              }
              title={!sidebarOpen ? item.label : undefined}
            >
              <span className="flex-shrink-0">{item.icon}</span>
              {sidebarOpen && <span className="truncate">{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* User section */}
        {user && (
          <div className={cn('p-3 border-t border-white/[0.06]', !sidebarOpen && 'p-2')}>
            {sidebarOpen ? (
              <div className="flex items-center gap-2.5">
                <Avatar name={user.name} avatarUrl={user.avatar} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200 truncate">{user.name}</p>
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

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="flex h-16 items-center gap-4 px-6 border-b border-white/[0.06] bg-gray-950/80 backdrop-blur-sm flex-shrink-0">
          {/* Sidebar toggle */}
          <button
            onClick={() => {
              toggleSidebar();
              setMobileOpen(!mobileOpen);
            }}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* Page title */}
          {title && (
            <h1 className="text-lg font-semibold text-gray-100 hidden md:block">{title}</h1>
          )}

          <div className="flex-1" />

          {/* Search */}
          <div className="relative hidden md:flex items-center">
            <Search className="absolute left-3 h-4 w-4 text-gray-500 pointer-events-none" />
            <input
              type="search"
              placeholder="Search recordings..."
              className="input-base pl-9 w-64 text-sm h-9"
            />
          </div>

          {/* Notifications */}
          <button
            className="relative p-2 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] transition-colors"
            onClick={() => navigate('/settings')}
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-[10px] font-bold text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {/* User menu */}
          {user && (
            <Dropdown>
              <DropdownTrigger asChild>
                <button className="flex items-center gap-2 rounded-xl p-1 pr-2 hover:bg-white/[0.06] transition-colors">
                  <Avatar name={user.name} avatarUrl={user.avatar} size="sm" />
                  <ChevronDown className="h-3.5 w-3.5 text-gray-500" />
                </button>
              </DropdownTrigger>
              <DropdownContent align="end" className="w-52">
                <div className="px-2.5 py-2 border-b border-white/[0.06] mb-1">
                  <p className="text-sm font-medium text-gray-200 truncate">{user.name}</p>
                  <p className="text-xs text-gray-500 truncate">{user.email}</p>
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
        <main className="flex-1 overflow-y-auto bg-gray-950">
          <div className="p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

// ─── Avatar ────────────────────────────────────────────────────────────────────

interface AvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
}

function Avatar({ name, avatarUrl, size = 'md' }: AvatarProps) {
  const sizes = { sm: 'h-7 w-7 text-xs', md: 'h-8 w-8 text-sm', lg: 'h-10 w-10 text-base' };
  return (
    <div
      className={cn(
        'rounded-full overflow-hidden flex-shrink-0 bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center font-semibold text-white',
        sizes[size],
      )}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} className="w-full h-full object-cover" />
      ) : (
        getInitials(name)
      )}
    </div>
  );
}
