import { useQuery } from '@tanstack/react-query';
import { api } from '@services/api';

type Range = '7d' | '30d' | '90d';

export const analyticsKeys = {
  all: ['analytics'] as const,
  dashboard: () => [...analyticsKeys.all, 'dashboard'] as const,
  overview: (range: Range) => [...analyticsKeys.all, 'overview', range] as const,
  recording: (id: string, range: Range) => [...analyticsKeys.all, 'recording', id, range] as const,
  activity: () => [...analyticsKeys.all, 'activity'] as const,
};

/** Dashboard summary stats */
export function useDashboardStats() {
  return useQuery({
    queryKey: analyticsKeys.dashboard(),
    queryFn: api.getDashboardStats.bind(api),
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
}

/** Overview analytics with range selector */
export function useOverviewAnalytics(range: Range = '30d') {
  return useQuery({
    queryKey: analyticsKeys.overview(range),
    queryFn: () => api.getOverviewAnalytics(range),
    staleTime: 120_000,
  });
}

/** Per-recording analytics */
export function useRecordingAnalytics(recordingId: string, range: Range = '30d') {
  return useQuery({
    queryKey: analyticsKeys.recording(recordingId, range),
    queryFn: () => api.getRecordingAnalytics(recordingId, range),
    enabled: !!recordingId,
    staleTime: 120_000,
  });
}

/** Activity feed */
export function useActivityFeed() {
  return useQuery({
    queryKey: analyticsKeys.activity(),
    queryFn: api.getActivityFeed.bind(api),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
