// In-memory access token, mirrored to sessionStorage so a page reload in the
// same tab doesn't force a re-login. The refresh token never touches JS: it is
// an HttpOnly cookie managed by the server.

import type { Role } from './types';

const STORAGE_KEY = 'groupops.accessToken';

export interface Session {
  accessToken: string;
  userId: string;
  username: string;
  role: Role;
  exp: number;
}

type Listener = () => void;

let accessToken: string | null = readStorage();
let session: Session | null = accessToken ? decodeSession(accessToken) : null;
const listeners = new Set<Listener>();

function readStorage(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(token: string | null) {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: memory-only is fine */
  }
}

/** Decode a JWT payload (base64url). No signature verification — the server does that. */
export function decodeSession(token: string): Session | null {
  try {
    const part = token.split('.')[1];
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    );
    const payload = JSON.parse(json) as { sub: string; username: string; role: Role; exp: number };
    return { accessToken: token, userId: payload.sub, username: payload.username, role: payload.role, exp: payload.exp };
  } catch {
    return null;
  }
}

export const tokenStore = {
  getToken: (): string | null => accessToken,
  getSession: (): Session | null => session,

  set(token: string | null) {
    const next = token ? decodeSession(token) : null;
    accessToken = next ? token : null;
    session = next;
    writeStorage(accessToken);
    listeners.forEach((l) => l());
  },

  clear() {
    tokenStore.set(null);
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
