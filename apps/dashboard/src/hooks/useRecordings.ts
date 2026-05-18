import { useMutation, useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '@services/api';
import type { RecordingQuery, UpdateRecordingRequest } from '@snaptrace/types';

export const recordingKeys = {
  all: ['recordings'] as const,
  lists: () => [...recordingKeys.all, 'list'] as const,
  list: (q: RecordingQuery) => [...recordingKeys.lists(), q] as const,
  detail: (id: string) => [...recordingKeys.all, 'detail', id] as const,
  share: (shareId: string) => [...recordingKeys.all, 'share', shareId] as const,
  comments: (id: string) => [...recordingKeys.all, 'comments', id] as const,
};

/** Fetch paginated recordings */
export function useRecordings(query: RecordingQuery = {}) {
  return useQuery({
    queryKey: recordingKeys.list(query),
    queryFn: () => api.getRecordings(query),
    staleTime: 30_000,
  });
}

/** Fetch a single recording */
export function useRecording(id: string) {
  return useQuery({
    queryKey: recordingKeys.detail(id),
    queryFn: () => api.getRecording(id),
    enabled: !!id,
  });
}

/** Fetch a public recording by shareId, polling every 2s while PROCESSING/UPLOADING or on 404 */
export function useSharedRecording(shareId: string) {
  return useQuery({
    queryKey: recordingKeys.share(shareId),
    queryFn: () => api.getRecordingByShareId(shareId),
    enabled: !!shareId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'PROCESSING' || status === 'UPLOADING') return 2000;
      // Poll on 404 — recording may still be mid-upload when the share page opens
      if (query.state.error) return 3000;
      return false;
    },
    // Retry 404s: recording might not be visible yet while chunks are uploading
    retry: (failureCount, error: unknown) => {
      const status = (error as { status?: number } | null)?.status;
      if (status === 404) return failureCount < 15;
      return false;
    },
    retryDelay: 2000,
    staleTime: 0,
  });
}

/** Update a recording */
export function useUpdateRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateRecordingRequest }) =>
      api.updateRecording(id, body),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: recordingKeys.lists() });
      qc.setQueryData(recordingKeys.detail(updated.id), updated);
      toast.success('Recording updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

/** Delete a recording */
export function useDeleteRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRecording(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: recordingKeys.lists() });
      qc.removeQueries({ queryKey: recordingKeys.detail(id) });
      toast.success('Recording deleted');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

/** Get comments for a recording */
export function useComments(recordingId: string) {
  return useQuery({
    queryKey: recordingKeys.comments(recordingId),
    queryFn: () => api.getComments(recordingId),
    enabled: !!recordingId,
  });
}

/** Create a comment */
export function useCreateComment(recordingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; timestamp?: number; parentId?: string }) =>
      api.createComment(recordingId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: recordingKeys.comments(recordingId) });
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

/** Delete a comment */
export function useDeleteComment(recordingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.deleteComment(recordingId, commentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: recordingKeys.comments(recordingId) });
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
