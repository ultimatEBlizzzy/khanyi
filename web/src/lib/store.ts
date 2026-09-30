import { useCallback, useEffect, useState } from 'react';
import api from './api';
import { useLiveFeed } from './live';
import type { StoreStatus } from './types';

/**
 * Live store status shared by the header ribbon, the basket and checkout.
 * Polls as a safety net, but reacts instantly to `store.updated` events.
 */
export function useStoreStatus(pollMs = 30_000) {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.get<StoreStatus>('/api/store/status');
      setStatus(next);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    if (pollMs <= 0) return;
    const timer = window.setInterval(load, pollMs);
    return () => window.clearInterval(timer);
  }, [load, pollMs]);

  useLiveFeed(['orders', 'store'], (event) => {
    if (event.type === 'store.updated' || event.type === 'menu.updated' || event.type === 'driver.status') {
      void load();
    }
  });

  return { status, error, reload: load };
}

export default useStoreStatus;
