import { useState, useEffect, useCallback, useRef } from 'react';
import { getCachedData, setCachedData, fetchWithCache, invalidateCache, toCacheKey } from '../lib/cache';

/**
 * Custom React hook for data fetching with client-side caching.
 *
 * @param {string|Array} key - Cache key
 * @param {Function} fetcher - Async function returning data
 * @param {Object} options - Configuration options:
 *   - `ttl`: Time in ms before data is considered stale (default: 60,000ms = 1 min)
 *   - `enabled`: Whether the query should automatically run (default: true)
 *   - `persist`: Whether to sync cache to sessionStorage (default: false)
 *   - `swr`: Stale-While-Revalidate support (default: true)
 *   - `onSuccess`: Callback invoked on successful fetch
 *   - `onError`: Callback invoked on fetch error
 */
export function useCachedQuery(key, fetcher, options = {}) {
  const {
    ttl = 60000,
    enabled = true,
    persist = false,
    swr = true,
    onSuccess,
    onError,
  } = options;

  const normalizedKey = key ? toCacheKey(key) : null;
  const initialCache = normalizedKey ? getCachedData(normalizedKey, { persist }) : null;

  const [data, setData] = useState(() => initialCache?.data ?? null);
  const [loading, setLoading] = useState(() => (initialCache ? false : Boolean(enabled && normalizedKey)));
  const [error, setError] = useState(null);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const execute = useCallback(
    async (forceRefresh = false) => {
      if (!normalizedKey || !enabled) return;

      if (!forceRefresh) {
        const cached = getCachedData(normalizedKey, { persist });
        if (cached && !cached.isExpired) {
          setData(cached.data);
          if (!cached.isStale) {
            setLoading(false);
            return cached.data;
          }
        }
      }

      // If we don't have existing cached data, indicate loading
      if (!data) {
        setLoading(true);
      }

      try {
        setError(null);
        const result = await fetchWithCache(normalizedKey, () => fetcherRef.current(), {
          ttl,
          swr,
          persist,
          forceRefresh,
        });

        setData(result);
        onSuccessRef.current?.(result);
        return result;
      } catch (err) {
        setError(err);
        onErrorRef.current?.(err);
      } finally {
        setLoading(false);
      }
    },
    [normalizedKey, enabled, ttl, swr, persist, data]
  );

  useEffect(() => {
    if (enabled && normalizedKey) {
      execute();
    }
  }, [normalizedKey, enabled]);

  const refetch = useCallback(() => execute(true), [execute]);

  const mutate = useCallback(
    (updater) => {
      if (!normalizedKey) return;
      setData((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        setCachedData(normalizedKey, next, { ttl, swr, persist });
        return next;
      });
    },
    [normalizedKey, ttl, swr, persist]
  );

  return {
    data,
    loading,
    error,
    refetch,
    mutate,
    invalidate: () => normalizedKey && invalidateCache(normalizedKey),
  };
}

