import { useEffect, useState } from 'react';
import { STORAGE_KEYS } from '@/types';

// Our own API file thumbnails (…/api/vN/{project}/files/…) require a Bearer
// token, so a plain <img src> can't load them (it 401s → blank). Everything else
// — data: URIs, external URLs — is already renderable and must NOT be routed
// through the fetch (that would mangle it into a broken request).
const API_FILE_PATTERN = /\/api\/v\d+\/[^/]+\/files\//;

const isAuthedApiFile = (url?: string | null): url is string =>
  !!url && !url.startsWith('data:') && API_FILE_PATTERN.test(url);

/**
 * Resolves a thumbnail URL to a renderable src:
 * - authenticated API file  → fetched as a blob (object URL); null while loading/on error
 * - data: URI / external URL → returned unchanged (no network call)
 * - empty                    → null
 */
export function useAuthedThumbnail(thumbnailUrl?: string | null): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const authed = isAuthedApiFile(thumbnailUrl);

  useEffect(() => {
    if (!authed) {
      setBlobUrl(null);
      return;
    }
    let revoked = false;
    let created: string | null = null;
    void (async () => {
      try {
        const r = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
        const token = (r[STORAGE_KEYS.AUTH_TOKENS] as { accessToken?: string } | undefined)
          ?.accessToken;
        const res = await fetch(thumbnailUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`Thumbnail fetch failed (${res.status})`);
        const blob = await res.blob();
        if (revoked) return;
        created = URL.createObjectURL(blob);
        setBlobUrl(created);
      } catch {
        if (!revoked) setBlobUrl(null);
      }
    })();
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [authed, thumbnailUrl]);

  if (!thumbnailUrl) return null;
  return authed ? blobUrl : thumbnailUrl;
}
