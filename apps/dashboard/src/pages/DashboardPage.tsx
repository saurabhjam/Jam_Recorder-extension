import React from 'react';
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
  Users,
  Plus,
  ArrowRight,
  PlayCircle,
  MessageSquare,
  Share2,
  Download,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { StatsCard } from '@components/StatsCard';
import { SkeletonStats, SkeletonCard } from '@components/Skeleton';
import { Button } from '@components/ui/Button';
import { Badge } from '@components/ui/Badge';
import { useDashboardStats, useActivityFeed } from '@hooks/useAnalytics';
import { useRecordings } from '@hooks/useRecordings';
import { formatBytes, formatDuration, formatRelativeDate, truncate } from '@utils/index';

// Mock chart data (replaced by real data when API is connected)
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
  comment: <MessageSquare className="h-3.5 w-3.5 text-yellow-400" />,
  share: <Share2 className="h-3.5 w-3.5 text-purple-400" />,
  download: <Download className="h-3.5 w-3.5 text-gray-400" />,
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
    <div className="bg-gray-900 border border-white/[0.08] rounded-xl px-3 py-2.5 shadow-xl text-xs">
      <p className="text-gray-400 mb-1.5">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <div
            className={`w-1.5 h-1.5 rounded-full ${p.dataKey === 'views' ? 'bg-violet-400' : 'bg-blue-400'}`}
          />
          <span className="text-gray-300">
            {p.dataKey === 'views' ? 'Views' : 'Recordings'}:{' '}
            <strong className="text-white">{p.value}</strong>
          </span>
        </div>
      ))}
    </div>
  );
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data: stats, isLoading: statsLoading } = useDashboardStats();
  const { data: activity, isLoading: activityLoad } = useActivityFeed();
  const { data: recordings, isLoading: recsLoading } = useRecordings({
    limit: 10,
    sortBy: 'createdAt',
    sortOrder: 'desc',
  });

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      {/* ── Welcome header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Here's what's happening with your recordings
          </p>
        </div>
        <Button
          size="md"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => window.open('https://snaptrace.app', '_blank')}
          className="hidden md:flex"
        >
          New recording
        </Button>
      </div>

      {/* ── Stats row ──────────────────────────────────────────────── */}
      {statsLoading ? (
        <SkeletonStats />
      ) : (
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08 } } }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-4"
        >
          {[
            {
              label: 'Total recordings',
              value: stats?.totalRecordings ?? 0,
              change: stats?.recordingsChange,
              icon: <Video className="h-5 w-5" />,
              iconColor: 'text-violet-400 bg-violet-400/10',
            },
            {
              label: 'Total views',
              value: stats?.totalViews ?? 0,
              change: stats?.viewsChange,
              icon: <Eye className="h-5 w-5" />,
              iconColor: 'text-blue-400 bg-blue-400/10',
            },
            {
              label: 'Storage used',
              value: formatBytes(stats?.storageUsed ?? 0),
              change: stats?.storageChange,
              icon: <HardDrive className="h-5 w-5" />,
              iconColor: 'text-emerald-400 bg-emerald-400/10',
            },
            {
              label: 'Team members',
              value: stats?.teamMembers ?? 1,
              icon: <Users className="h-5 w-5" />,
              iconColor: 'text-orange-400 bg-orange-400/10',
            },
          ].map((s) => (
            <motion.div
              key={s.label}
              variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
            >
              <StatsCard
                label={s.label}
                value={s.value}
                change={s.change}
                changeLabel="vs last month"
                icon={s.icon}
                iconColor={s.iconColor}
              />
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* ── Main grid ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Chart — takes 2 columns */}
        <div className="xl:col-span-2 card p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-sm font-semibold text-gray-200">Recording activity</h2>
              <p className="text-xs text-gray-500 mt-0.5">Last 30 days</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate('/analytics')}>
              View all <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="views" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="recs" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.05)"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: '#6b7280' }}
                tickLine={false}
                axisLine={false}
                interval={6}
              />
              <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="views"
                stroke="#8b5cf6"
                strokeWidth={2}
                fill="url(#views)"
                dot={false}
                activeDot={{ r: 4, fill: '#8b5cf6', stroke: '#1a1f2e', strokeWidth: 2 }}
              />
              <Area
                type="monotone"
                dataKey="recordings"
                stroke="#60a5fa"
                strokeWidth={2}
                fill="url(#recs)"
                dot={false}
                activeDot={{ r: 4, fill: '#60a5fa', stroke: '#1a1f2e', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>

          <div className="flex items-center gap-4 mt-4 justify-center">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <div className="w-2.5 h-2.5 rounded-full bg-violet-500" />
              Views
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <div className="w-2.5 h-2.5 rounded-full bg-blue-400" />
              Recordings
            </div>
          </div>
        </div>

        {/* Activity feed */}
        <div className="card p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-200">Activity</h2>
            <Badge variant="default" size="sm">
              {activity?.length ?? 0}
            </Badge>
          </div>

          {activityLoad ? (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonCard key={i} className="p-0 bg-transparent border-0 shadow-none" />
              ))}
            </div>
          ) : activity && activity.length > 0 ? (
            <div className="space-y-3 overflow-y-auto max-h-[280px] no-scrollbar">
              {activity.map((item) => (
                <div key={item.id} className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5 p-1.5 rounded-lg bg-white/[0.04]">
                    {activityIcons[item.type] ?? <Video className="h-3.5 w-3.5 text-gray-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-300 leading-relaxed">{item.message}</p>
                    <p className="text-[11px] text-gray-600 mt-0.5">
                      {formatRelativeDate(item.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-40 text-center">
              <Video className="h-8 w-8 text-gray-700 mb-2" />
              <p className="text-sm text-gray-600">No recent activity</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent recordings ───────────────────────────────────────── */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-gray-200">Recent recordings</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('/library')}>
            View all <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>

        {recsLoading ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 animate-pulse">
                <div className="h-12 w-20 rounded-lg bg-white/[0.04]" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/2 rounded bg-white/[0.04]" />
                  <div className="h-3 w-1/4 rounded bg-white/[0.04]" />
                </div>
              </div>
            ))}
          </div>
        ) : recordings?.data && recordings.data.length > 0 ? (
          <div className="divide-y divide-white/[0.04]">
            {recordings.data.map((rec) => (
              <div
                key={rec.id}
                className="flex items-center gap-4 px-5 py-3.5 hover:bg-white/[0.02] transition-colors cursor-pointer group"
                onClick={() => navigate(`/library`)}
              >
                {/* Thumbnail */}
                <div className="flex-shrink-0 h-12 w-20 rounded-lg bg-gray-800 overflow-hidden">
                  {rec.thumbnailUrl ? (
                    <img
                      src={rec.thumbnailUrl}
                      alt={rec.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Video className="h-4 w-4 text-gray-600" />
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200 truncate group-hover:text-violet-300 transition-colors">
                    {rec.title}
                  </p>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-xs text-gray-500">
                      {formatRelativeDate(rec.createdAt)}
                    </span>
                    {rec.duration && (
                      <span className="text-xs text-gray-600">{formatDuration(rec.duration)}</span>
                    )}
                  </div>
                </div>

                {/* Views */}
                <div className="flex items-center gap-1.5 text-xs text-gray-500 flex-shrink-0">
                  <Eye className="h-3.5 w-3.5" />
                  {rec.viewCount}
                </div>

                {/* Status badge */}
                <Badge
                  variant={
                    rec.status === 'READY'
                      ? 'success'
                      : rec.status === 'PROCESSING'
                        ? 'warning'
                        : 'danger'
                  }
                  size="sm"
                  dot
                >
                  {rec.status}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="h-16 w-16 rounded-2xl bg-violet-400/10 flex items-center justify-center mb-4">
              <Video className="h-8 w-8 text-violet-400" />
            </div>
            <h3 className="text-base font-medium text-gray-300 mb-1">No recordings yet</h3>
            <p className="text-sm text-gray-500 mb-6">
              Install the SnapTrace extension and record your first bug
            </p>
            <Button size="md" leftIcon={<Plus className="h-4 w-4" />}>
              Get started
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
