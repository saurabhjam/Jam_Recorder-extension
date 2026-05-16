import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  Video,
  Eye,
  HardDrive,
  CalendarDays,
  Plus,
  ArrowRight,
  PlayCircle,
  MessageSquare,
  Share2,
  Download,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { StatsCard } from '@components/StatsCard';
import { RecordingCard } from '@components/RecordingCard';
import { SkeletonStats, SkeletonRecordingCard } from '@components/Skeleton';
import { Button } from '@components/ui/Button';
import { useDashboardStats, useActivityFeed } from '@hooks/useAnalytics';
import { useRecordings, useDeleteRecording, useUpdateRecording } from '@hooks/useRecordings';
import { formatBytes, formatDuration, formatRelativeDate } from '@utils/index';
import { useAuth } from '@hooks/useAuth';
import { api } from '@services/api';

const generateChartData = () => {
  const days: Array<{ date: string; views: number; recordings: number }> = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push({
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      views: Math.floor(Math.random() * 120) + 20,
      recordings: Math.floor(Math.random() * 8),
    });
  }
  return days;
};

const chartData = generateChartData();

const activityIcons: Record<string, React.ReactNode> = {
  view: <Eye className="h-3.5 w-3.5 text-blue-400" />,
  play: <PlayCircle className="h-3.5 w-3.5 text-green-400" />,
  comment: <MessageSquare className="h-3.5 w-3.5 text-amber-400" />,
  share: <Share2 className="h-3.5 w-3.5 text-violet-400" />,
  download: <Download className="h-3.5 w-3.5 text-slate-400" />,
};

const CustomTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string }>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="px-3 py-2.5 rounded-xl text-xs shadow-2xl"
      style={{
        background: 'rgba(11,16,32,0.95)',
        border: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <p className="text-slate-400 mb-1.5 font-medium">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <div
            className={`w-1.5 h-1.5 rounded-full ${p.dataKey === 'views' ? 'bg-violet-400' : 'bg-blue-400'}`}
          />
          <span className="text-slate-300">
            {p.dataKey === 'views' ? 'Views' : 'Recordings'}:{' '}
            <strong className="text-white">{p.value}</strong>
          </span>
        </div>
      ))}
    </div>
  );
};

// Get time-based greeting
function getGreeting(name: string): string {
  const hour = new Date().getHours();
  const firstName = name?.split(' ')[0] ?? 'there';
  if (hour < 12) return `Good morning, ${firstName} 👋`;
  if (hour < 17) return `Good afternoon, ${firstName} 👋`;
  return `Good evening, ${firstName} 👋`;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: stats, isLoading: statsLoading } = useDashboardStats();
  const { data: activity, isLoading: activityLoad } = useActivityFeed();
  const { data: recordings, isLoading: recsLoading } = useRecordings({
    limit: 8,
    sortBy: 'createdAt',
    sortOrder: 'desc',
  });
  const { mutate: deleteRecording } = useDeleteRecording();
  const { mutate: updateRecording } = useUpdateRecording();

  const greeting = getGreeting(user?.name ?? 'there');

  const statsConfig = [
    {
      label: 'Total Recordings',
      value: stats?.totalRecordings ?? 0,
      change: stats?.recordingsChange,
      icon: <Video className="h-5 w-5" />,
      iconColor: 'text-violet-400',
      accentColor: 'rgba(139,92,246,0.15)',
    },
    {
      label: 'Total Views',
      value: stats?.totalViews ?? 0,
      change: stats?.viewsChange,
      icon: <Eye className="h-5 w-5" />,
      iconColor: 'text-blue-400',
      accentColor: 'rgba(96,165,250,0.15)',
    },
    {
      label: 'Storage Used',
      value: formatBytes(stats?.storageUsed ?? 0),
      change: stats?.storageChange,
      icon: <HardDrive className="h-5 w-5" />,
      iconColor: 'text-emerald-400',
      accentColor: 'rgba(52,211,153,0.15)',
    },
    {
      label: 'This Month',
      value: stats?.teamMembers ?? 1,
      icon: <CalendarDays className="h-5 w-5" />,
      iconColor: 'text-amber-400',
      accentColor: 'rgba(251,191,36,0.15)',
    },
  ];

  const handleDownload = async (id: string) => {
    const blob = await api.downloadRecording(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snaptrace-recording-${id}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8 max-w-[1400px] mx-auto">
      {/* Hero greeting */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="text-3xl font-bold text-slate-50 tracking-tight">{greeting}</h1>
          <p className="text-base text-slate-500 mt-1">
            Here's an overview of your recording activity
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <button
            onClick={() => window.open('https://snaptrace.app', '_blank')}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0"
            style={{
              background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
              boxShadow: '0 4px 20px rgba(124,58,237,0.4), 0 1px 3px rgba(0,0,0,0.3)',
            }}
          >
            <Plus className="h-4 w-4" />
            New Recording
          </button>
        </motion.div>
      </div>

      {/* Stats cards */}
      {statsLoading ? (
        <SkeletonStats />
      ) : (
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.07 } } }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-4"
        >
          {statsConfig.map((s) => (
            <motion.div
              key={s.label}
              variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } }}
            >
              <StatsCard
                label={s.label}
                value={s.value}
                change={s.change}
                changeLabel="vs last month"
                icon={s.icon}
                iconColor={s.iconColor}
                accentColor={s.accentColor}
              />
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* Chart + Activity */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Activity chart */}
        <div
          className="xl:col-span-2 rounded-2xl p-6"
          style={{
            background:
              'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
            border: '1px solid rgba(255,255,255,0.07)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          }}
        >
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">Recording Activity</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Views & recordings over the last 30 days
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate('/analytics')}>
              View all <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>

          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="views" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="recs" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.04)"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: '#64748b' }}
                tickLine={false}
                axisLine={false}
                interval={6}
              />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="views"
                stroke="#8b5cf6"
                strokeWidth={2}
                fill="url(#views)"
                dot={false}
                activeDot={{ r: 4, fill: '#8b5cf6', stroke: '#0B1020', strokeWidth: 2 }}
              />
              <Area
                type="monotone"
                dataKey="recordings"
                stroke="#60a5fa"
                strokeWidth={2}
                fill="url(#recs)"
                dot={false}
                activeDot={{ r: 4, fill: '#60a5fa', stroke: '#0B1020', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>

          <div className="flex items-center gap-5 mt-4 justify-center">
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#8b5cf6' }} />
              Views
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#60a5fa' }} />
              Recordings
            </div>
          </div>
        </div>

        {/* Activity feed */}
        <div
          className="rounded-2xl p-6"
          style={{
            background:
              'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
            border: '1px solid rgba(255,255,255,0.07)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          }}
        >
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-sm font-semibold text-slate-200">Recent Activity</h2>
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(139,92,246,0.15)', color: '#c4b5fd' }}
            >
              {activity?.length ?? 0}
            </span>
          </div>

          {activityLoad ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 animate-pulse">
                  <div
                    className="h-8 w-8 rounded-lg flex-shrink-0"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  />
                  <div className="flex-1 space-y-1.5">
                    <div
                      className="h-3 w-4/5 rounded"
                      style={{ background: 'rgba(255,255,255,0.04)' }}
                    />
                    <div
                      className="h-2.5 w-1/3 rounded"
                      style={{ background: 'rgba(255,255,255,0.04)' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : activity && activity.length > 0 ? (
            <div className="space-y-3 overflow-y-auto max-h-[280px] no-scrollbar">
              {activity.map((item) => (
                <div key={item.id} className="flex items-start gap-3">
                  <div
                    className="flex-shrink-0 mt-0.5 p-2 rounded-lg"
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.07)',
                    }}
                  >
                    {activityIcons[item.type] ?? <Video className="h-3.5 w-3.5 text-slate-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-300 leading-relaxed">{item.message}</p>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      {formatRelativeDate(item.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-40 text-center">
              <div
                className="h-12 w-12 rounded-xl flex items-center justify-center mb-3"
                style={{
                  background: 'rgba(139,92,246,0.1)',
                  border: '1px solid rgba(139,92,246,0.15)',
                }}
              >
                <Video className="h-5 w-5 text-violet-400" />
              </div>
              <p className="text-sm text-slate-500">No recent activity</p>
            </div>
          )}
        </div>
      </div>

      {/* Recent recordings section */}
      <div>
        {/* Section header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-5">
          <div>
            <h2 className="text-lg font-bold text-slate-100">Recent Recordings</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {recordings?.total
                ? `${recordings.total} total recording${recordings.total !== 1 ? 's' : ''}`
                : 'Your latest recordings'}
            </p>
          </div>

          <div className="sm:ml-auto flex flex-wrap items-center gap-3">
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 pointer-events-none" />
              <input
                type="search"
                placeholder="Search..."
                className="pl-8 pr-4 h-9 w-44 text-sm rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              />
            </div>

            {/* Filter pill */}
            <button
              className="inline-flex items-center gap-1.5 px-3 h-9 rounded-xl text-sm text-slate-400 transition-colors hover:text-slate-200"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              All
            </button>

            {/* View all */}
            <Button variant="ghost" size="sm" onClick={() => navigate('/library')}>
              View all <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>

            {/* New recording */}
            <button
              onClick={() => window.open('https://snaptrace.app', '_blank')}
              className="inline-flex items-center gap-1.5 px-4 h-9 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-px"
              style={{
                background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
                boxShadow: '0 4px 14px rgba(124,58,237,0.35)',
              }}
            >
              <Plus className="h-4 w-4" />
              New Recording
            </button>
          </div>
        </div>

        {/* Grid */}
        {recsLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonRecordingCard key={i} />
            ))}
          </div>
        ) : recordings?.data && recordings.data.length > 0 ? (
          <motion.div
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
          >
            {recordings.data.map((rec) => (
              <motion.div
                key={rec.id}
                variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
              >
                <RecordingCard
                  recording={rec}
                  view="grid"
                  onDelete={(id) => deleteRecording(id)}
                  onEdit={(id, title) => updateRecording({ id, body: { title } })}
                  onDownload={handleDownload}
                  onClick={() => navigate('/library')}
                />
              </motion.div>
            ))}
          </motion.div>
        ) : (
          /* Empty state */
          <div
            className="flex flex-col items-center justify-center py-24 text-center rounded-2xl"
            style={{
              background:
                'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            <div
              className="h-16 w-16 rounded-2xl flex items-center justify-center mb-4"
              style={{
                background: 'rgba(139,92,246,0.1)',
                border: '1px solid rgba(139,92,246,0.15)',
              }}
            >
              <Video className="h-7 w-7 text-violet-400" />
            </div>
            <h3 className="text-base font-semibold text-slate-300 mb-1">No recordings yet</h3>
            <p className="text-sm text-slate-500 mb-6 max-w-xs">
              Install the SnapTrace extension and start recording your first bug or workflow.
            </p>
            <button
              onClick={() => window.open('https://snaptrace.app', '_blank')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5"
              style={{
                background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
                boxShadow: '0 4px 14px rgba(124,58,237,0.35)',
              }}
            >
              <Plus className="h-4 w-4" />
              Get started
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
