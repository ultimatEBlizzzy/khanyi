import { useEffect, useRef, useState } from 'react';
import { liveUrl, tokenStore } from './api';
import type { LiveEvent } from './types';

/**
 * Subscribe to the server's live feed.
 *
 * EventSource reconnects on its own and replays anything missed using the
 * `Last-Event-ID` header — the server keeps a ring buffer for exactly that.
 * The callback is held in a ref so re-renders never tear the stream down.
 */
export function useLiveFeed(
  topics: string[],
  onEvent?: (event: LiveEvent<any>) => void,
  options: { enabled?: boolean } = {},
) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<LiveEvent<any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const key = topics.join(',');

  useEffect(() => {
    if (options.enabled === false || !tokenStore.get()) return;

    let source: EventSource | null = null;
    let closed = false;
    let retryTimer: number | undefined;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      source = new EventSource(liveUrl(key.split(',').filter(Boolean)));

      source.addEventListener('hello', () => {
        attempt = 0;
        setConnected(true);
        setError(null);
      });

      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as LiveEvent<any>;
          setLastEvent(event);
          handlerRef.current?.(event);
        } catch {
          /* a malformed frame is not worth killing the stream for */
        }
      };

      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (closed) return;
        // Back off, but never so far that a rider stops seeing orders.
        attempt += 1;
        const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
        setError('Reconnecting to the live feed…');
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      source?.close();
      setConnected(false);
    };
  }, [key, options.enabled]);

  return { connected, lastEvent, error };
}

/** Keep the browser tab title honest about what is waiting. */
export function useDocumentBadge(count: number, base: string) {
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [count, base]);
}
