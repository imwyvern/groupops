// Fetch wrapper: bearer auth, error normalisation, and 401 → refresh → retry-once.
//
// Single-flight refresh: all concurrent 401s await the SAME in-flight refresh
// promise, so N parallel failing requests cause exactly one POST /auth/refresh.
// Additionally, a request that was sent with an already-superseded token (i.e.
// a refresh completed while it was in flight) simply retries with the new token
// instead of starting a second refresh.

import { tokenStore } from './tokenStore';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /** Any additional fields from the error body, e.g. `stepIndex`, `key`. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Human-readable "code: message" for display. */
export function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return `NETWORK_ERROR: ${err.message}`;
  return String(err);
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    const { code, message, requestId, ...extra } = body?.error ?? {};
    if (typeof code === 'string') {
      return new ApiError(res.status, code, message ?? res.statusText, requestId, extra);
    }
  } catch {
    /* non-JSON body (e.g. proxy error when backend is down) */
  }
  return new ApiError(res.status, `HTTP_${res.status}`, res.statusText || 'Request failed');
}

async function parseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------------------------------------------------------------------------
// Auth endpoints (deliberately NOT routed through `api()` to avoid recursion)
// ---------------------------------------------------------------------------

let inflightRefresh: Promise<string> | null = null;

/**
 * Exchange the HttpOnly refresh cookie for a new access token.
 * Concurrent callers share one in-flight request. On failure the session is
 * cleared, which makes the router redirect to /login.
 */
export function refreshAccessToken(): Promise<string> {
  if (!inflightRefresh) {
    inflightRefresh = (async () => {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) throw await toApiError(res);
      const { accessToken } = await parseBody<{ accessToken: string }>(res);
      tokenStore.set(accessToken);
      return accessToken;
    })()
      .catch((err) => {
        tokenStore.clear();
        throw err;
      })
      .finally(() => {
        inflightRefresh = null;
      });
  }
  return inflightRefresh;
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await toApiError(res);
  const { accessToken } = await parseBody<{ accessToken: string }>(res);
  tokenStore.set(accessToken);
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } finally {
    tokenStore.clear();
  }
}

// ---------------------------------------------------------------------------
// Generic authenticated request
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function send(method: Method, path: string, body: unknown, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const usedToken = tokenStore.getToken();
  let res = await send(method, path, body, usedToken);

  if (res.status === 401) {
    const current = tokenStore.getToken();
    // If the token changed while we were in flight, someone already refreshed.
    const freshToken = current && current !== usedToken ? current : await refreshAccessToken();
    res = await send(method, path, body, freshToken);
    if (res.status === 401) {
      tokenStore.clear();
    }
  }

  if (!res.ok) throw await toApiError(res);
  return parseBody<T>(res);
}
