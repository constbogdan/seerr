import { FRESH_API_PATH } from '@app/components/Fresh/api';
import axios from 'axios';
import { useEffect } from 'react';
import { useSWRConfig } from 'swr';
import { unstable_serialize } from 'swr/infinite';

export const invalidateFreshCaches = async ({
  cache,
  mutate,
}: Pick<ReturnType<typeof useSWRConfig>, 'cache' | 'mutate'>) => {
  const pages = [...cache.keys()].filter(
    (key) => key === FRESH_API_PATH || key.startsWith(`${FRESH_API_PATH}?`)
  );
  const feeds = new Set(
    pages
      .filter(
        (key) => new URLSearchParams(key.split('?')[1]).get('page') === '1'
      )
      .map((key) => unstable_serialize(() => key))
  );
  // Global predicate mutation skips SWR's infinite aggregates. Clear their
  // constituent pages first, then explicitly revalidate each complete feed.
  await Promise.all(pages.map((key) => mutate(key, undefined, false)));
  await Promise.all(
    [...feeds].map((key) => mutate(key, undefined, { revalidate: true }))
  );
};

const FreshCacheInvalidation = () => {
  const { cache, mutate } = useSWRConfig();
  useEffect(() => {
    const interceptor = axios.interceptors.response.use((response) => {
      const { method, url = '' } = response.config;
      if (
        response.status >= 200 &&
        response.status < 300 &&
        ((method === 'put' && url === '/api/v1/settings/fresh') ||
          ((method === 'post' || method === 'delete') &&
            /^\/api\/v1\/blocklist(?:\/|$)/.test(url)))
      )
        // Cache failures must not turn a successful saved mutation into a failure.
        void invalidateFreshCaches({ cache, mutate }).catch(() => undefined);
      return response;
    });
    return () => axios.interceptors.response.eject(interceptor);
  }, [cache, mutate]);
  return null;
};

export default FreshCacheInvalidation;
