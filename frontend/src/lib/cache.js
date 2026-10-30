/**
 * Lightweight in-memory & optional storage caching layer with:
 *  - Configurable TTL (Time-To-Live)
 *  - Stale-While-Revalidate (SWR) support
 *  - In-flight promise deduplication (prevents duplicate simultaneous requests)
 *  - Cache invalidation and optimistic mutations
 */

const memoryCache = new Map();
const inFlightPromises = new Map();

const DEFAULT_TTL_MS = 60 * 1000; // 1 minute default TTL

/**
 * Normalizes cache key into a consistent string identifier.
 */
export const toCacheKey = (key) => {
  if (typeof key === 'string') return key;
  if (Array.isArray(key)) return key.map((k) => (typeof k === 'object' ? JSON.stringify(k) : String(k))).join(':');
  return JSON.stringify(key);
};

/**
 * Get an item from memory or sessionStorage.
 */
export const getCachedData = (key, { persist = false } = {}) => {
  const normalizedKey = toCacheKey(key);
  const cached = memoryCache.get(normalizedKey);

  if (cached) {
    const isStale = Date.now() > cached.expiresAt;
    return { data: cached.data, isStale, isExpired: isStale && !cached.swr };
  }

  if (persist && typeof window !== 'undefined') {
    try {
      const stored = sessionStorage.getItem(`comar_cache_${normalizedKey}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        const isStale = Date.now() > parsed.expiresAt;
        // Warm up memory cache
        memoryCache.set(normalizedKey, parsed);
        return { data: parsed.data, isStale, isExpired: isStale && !parsed.swr };
      }
    } catch {
      /* ignore storage parsing errors */
    }
  }

  return null;
};

/**
 * Set an item in cache with TTL and optional persistence.
 */
export const setCachedData = (key, data, { ttl = DEFAULT_TTL_MS, swr = true, persist = false } = {}) => {
  const normalizedKey = toCacheKey(key);
  const record = {
    data,
    updatedAt: Date.now(),
    expiresAt: Date.now() + ttl,
    swr,
    persist,
  };

  memoryCache.set(normalizedKey, record);

  if (persist && typeof window !== 'undefined') {
    try {
      sessionStorage.setItem(`comar_cache_${normalizedKey}`, JSON.stringify(record));
    } catch {
      /* ignore storage quota errors */
    }
  }
};

/**
 * Invalidate cache entry or entries matching a prefix.
 * @param {string|Array} keyOrPrefix - Key or key prefix to invalidate
 */
export const invalidateCache = (keyOrPrefix) => {
  const prefix = toCacheKey(keyOrPrefix);

  for (const k of memoryCache.keys()) {
    if (k === prefix || k.startsWith(`${prefix}:`) || k.startsWith(`${prefix}_`)) {
      memoryCache.delete(k);
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.removeItem(`comar_cache_${k}`);
        } catch {}
      }
    }
  }
};

/**
 * Optimistically mutate cached data without an immediate network call.
 */
export const mutateCache = (key, updater) => {
  const normalizedKey = toCacheKey(key);
  const current = getCachedData(normalizedKey);
  const newData = typeof updater === 'function' ? updater(current?.data) : updater;

  if (current) {
    setCachedData(normalizedKey, newData, {
      ttl: current.expiresAt - Date.now() > 0 ? current.expiresAt - Date.now() : DEFAULT_TTL_MS,
      swr: true,
      persist: current.persist,
    });
  } else {
    setCachedData(normalizedKey, newData);
  }

  return newData;
};

/**
 * Fetch with caching, in-flight request deduplication, and SWR.
 *
 * @param {string|Array} key - Unique cache key
 * @param {Function} fetcher - Async function that resolves to data
 * @param {Object} options - { ttl, swr = true, persist = false, forceRefresh = false }
 */
export const fetchWithCache = async (key, fetcher, options = {}) => {
  const { ttl = DEFAULT_TTL_MS, swr = true, persist = false, forceRefresh = false } = options;
  const normalizedKey = toCacheKey(key);

  if (!forceRefresh) {
    const cached = getCachedData(normalizedKey, { persist });
    if (cached && !cached.isExpired) {
      // Stale-While-Revalidate: return stale data immediately, revalidate silently in background
      if (cached.isStale && swr && !inFlightPromises.has(normalizedKey)) {
        const backgroundPromise = Promise.resolve().then(async () => {
          try {
            const fresh = await fetcher();
            setCachedData(normalizedKey, fresh, { ttl, swr, persist });
          } catch (err) {
            console.warn(`[Cache] Background revalidation failed for ${normalizedKey}:`, err.message);
          } finally {
            inFlightPromises.delete(normalizedKey);
          }
        });
        inFlightPromises.set(normalizedKey, backgroundPromise);
      }
      return cached.data;
    }
  }

  // Deduplicate concurrent in-flight requests for the same key
  if (inFlightPromises.has(normalizedKey)) {
    return inFlightPromises.get(normalizedKey);
  }

  const promise = (async () => {
    try {
      const data = await fetcher();
      setCachedData(normalizedKey, data, { ttl, swr, persist });
      return data;
    } finally {
      inFlightPromises.delete(normalizedKey);
    }
  })();

  inFlightPromises.set(normalizedKey, promise);
  return promise;
};

