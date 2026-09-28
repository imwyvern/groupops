import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { refreshAccessToken } from '../api/client';
import { tokenStore, type Session } from '../api/tokenStore';

interface AuthValue {
  session: Session | null;
  isAdmin: boolean;
  /** False until the initial silent-refresh attempt has settled. */
  ready: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(tokenStore.subscribe, tokenStore.getSession);
  const [ready, setReady] = useState(session !== null);

  // Bootstrap: no token in this tab, but the refresh cookie may still be valid.
  useEffect(() => {
    if (ready) return;
    refreshAccessToken()
      .catch(() => undefined)
      .finally(() => setReady(true));
    // Run once on mount only.
  }, []);

  const value: AuthValue = { session, isAdmin: session?.role === 'admin', ready };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** Renders children only for admins. Viewers never see write controls. */
export function AdminOnly({ children }: { children: ReactNode }) {
  return useAuth().isAdmin ? <>{children}</> : null;
}
