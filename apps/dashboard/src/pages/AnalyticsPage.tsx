import React, { useState } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Download, Globe, TrendingUp, Eye, Play, Clock, BarChart3 } from 'lucide-react';
import { Button } from '@components/ui/Button';
import { StatsCard } from '@components/StatsCard';
import { SkeletonStats } from '@components/Skeleton';
import { Tabs, TabsList, TabsTrigger } from '@components/ui/Tabs';
import { useOverviewAnalytics } from '@hooks/useAnalytics';
import { formatNumber, formatDuration } from '@utils/index';

type Range = '7d' | '30d' | '90d';

const RANGE_OPTIONS: Array<{ label: string; value: Range }> = [
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
];

const PIE_COLORS = ['#8b5cf6', '#60a5fa', '#34d399', '#f59e0b', '#f87171'];

const CustomTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 border border-white/[0.08] rounded-xl px-3 py-2.5 shadow-xl text-xs">
      <p className="text-gray-400 mb-1.5">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
          <span className="text-gray-300">
            {p.name}: <strong className="text-white">{p.value}</strong>
          </span>
        </div>
      ))}
    </div>
  );
};

const CustomPieTooltip = ({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number }>;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 border border-white/[0.08] rounded-xl px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-300">
        {payload[0].name}: <strong className="text-white">{payload[0].value}%</strong>
      </p>
    </div>
  );
};

export default function AnalyticsPage() {
  const [range, setRange] = useState<Range>('30d');
  const { data, isLoading } = useOverviewAnalytics(range);

  const handleExportCSV = () => {
    if (!data) return;
    const rows = data.viewsByDay.map((d) => `${d.date},${d.views},${d.plays}`);
    const csv = `Date,Views,Plays\n${rows.join('\n')}`;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jam-analytics-${range}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Analytics</h1>
          <p className="text-sm text-gray-500 mt-0.5">Understand how your recordings perform</p>
        </div>

        <div className="flex items-center gap-3">
          <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
            <TabsList variant="pills">
              {RANGE_OPTIONS.map((o) => (
                <TabsTrigger key={o.value} value={o.value} variant="pills" className="text-xs">
                  {o.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Download className="h-3.5 w-3.5" />}
            onClick={handleExportCSV}
            disabled={!data}
          >
            Export CSV
          </Button>
        </div>
      </div>

      {/* Stats */}
      {isLoading ? (
        <SkeletonStats />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard
            label="Total plays"
            value={formatNumber(data?.totalPlays ?? 0)}
            icon={<Play className="h-5 w-5" />}
            iconColor="text-violet-400 bg-violet-400/10"
          />
          <StatsCard
            label="Unique viewers"
            value={formatNumber(data?.uniqueViewers ?? 0)}
            icon={<Eye className="h-5 w-5" />}
            iconColor="text-blue-400 bg-blue-400/10"
          />
          <StatsCard
            label="Avg watch time"
            value={formatDuration(data?.avgWatchTime ?? 0)}
            icon={<Clock className="h-5 w-5" />}
            iconColor="text-emerald-400 bg-emerald-400/10"
          />
          <StatsCard
            label="Completion rate"
            value={`${data?.completionRate ?? 0}%`}
            icon={<TrendingUp className="h-5 w-5" />}
            iconColor="text-orange-400 bg-orange-400/10"
          />
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Views over time */}
        <div className="xl:col-span-2 card p-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-5">Views over time</h2>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart
              data={data?.viewsByDay ?? []}
              margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
            >
              <defs>
                <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="playsFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.25} />
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
                interval={Math.floor((data?.viewsByDay?.length ?? 7) / 7)}
              />
              <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="views"
                name="Views"
                stroke="#8b5cf6"
                strokeWidth={2}
                fill="url(#viewsFill)"
                dot={false}
              />
              <Area
                type="monotone"
                dataKey="plays"
                name="Plays"
                stroke="#60a5fa"
                strokeWidth={2}
                fill="url(#playsFill)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Traffic sources */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-5">Traffic sources</h2>
          {data?.sources && data.sources.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie
                    data={data.sources}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={3}
                  >
                    {data.sources.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomPieTooltip />} />
                </PieChart>
              </ResponsiveContainer>

              <div className="space-y-2 mt-3">
                {data.sources.map((s, i) => (
                  <div key={s.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                      />
                      <span className="text-gray-400">{s.name}</span>
                    </div>
                    <span className="text-gray-300 font-medium">{s.value}%</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-48">
              <BarChart3 className="h-8 w-8 text-gray-700 mb-2" />
              <p className="text-xs text-gray-600">No data available</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Top recordings */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-5">Top recordings</h2>
          {data?.topRecordings && data.topRecordings.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={data.topRecordings.slice(0, 8)}
                layout="vertical"
                margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(255,255,255,0.05)"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: '#6b7280' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="title"
                  width={120}
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: string) => (v.length > 18 ? v.slice(0, 18) + '…' : v)}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-gray-900 border border-white/[0.08] rounded-xl px-3 py-2 shadow-xl text-xs">
                        <p className="text-white font-medium">{payload[0].value} views</p>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="views" fill="#8b5cf6" radius={[0, 4, 4, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex flex-col items-center justify-center h-40">
              <BarChart3 className="h-8 w-8 text-gray-700 mb-2" />
              <p className="text-xs text-gray-600">No recording data</p>
            </div>
          )}
        </div>

        {/* Geography */}
        <div className="card p-6">
          <div className="flex items-center gap-2 mb-5">
            <Globe className="h-4 w-4 text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-200">Geographic breakdown</h2>
          </div>
          {data?.geography && data.geography.length > 0 ? (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left pb-3 text-xs font-medium text-gray-500">Country</th>
                    <th className="text-right pb-3 text-xs font-medium text-gray-500">Views</th>
                    <th className="text-right pb-3 text-xs font-medium text-gray-500">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {data.geography.map((g) => (
                    <tr key={g.country} className="hover:bg-white/[0.02]">
                      <td className="py-3">
                        <span className="text-gray-300">{g.country}</span>
                      </td>
                      <td className="py-3 text-right text-gray-400">{formatNumber(g.views)}</td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="flex-1 h-1.5 bg-gray-800 rounded-full max-w-[80px]">
                            <div
                              className="h-full bg-violet-500 rounded-full"
                              style={{ width: `${g.percentage}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-400 w-8 text-right">
                            {g.percentage}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-40">
              <Globe className="h-8 w-8 text-gray-700 mb-2" />
              <p className="text-xs text-gray-600">No geographic data yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
