/**
 * A tiny typed fetch client.
 *
 * Everything the UI knows about the network lives here: base URL, bearer
 * token, JSON handling, and turning the API's `{ error: { message } }`
 * envelope into a throwable `ApiError` the components can render.
 */

const TOKEN_KEY = 'kk.token';

/** Same origin in production; the Vite dev server proxies /api to the API. */
const BASE = '';

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export const tokenStore = {
  get: () => (typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, signal } = options;
  const token = options.token ?? tokenStore.get();

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('We could not reach the kitchen — check your connection.', 0);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error?.message ?? `Request failed (${response.status})`;
    // An expired or revoked token should not leave the UI pretending to be
    // signed in.
    if (response.status === 401) tokenStore.clear();
    throw new ApiError(message, response.status, payload?.error?.details);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'DELETE' }),
};

/** Absolute URL (+ token) for an EventSource, which cannot send headers. */
export function liveUrl(topics: string[], since?: number) {
  const params = new URLSearchParams();
  if (topics.length) params.set('topics', topics.join(','));
  if (since) params.set('since', String(since));
  const token = tokenStore.get();
  if (token) params.set('token', token);
  return `/api/events?${params.toString()}`;
}

export default api;
