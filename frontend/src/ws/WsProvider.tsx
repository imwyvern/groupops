import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WsEventMap, WsEventType } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { WsClient, type ConnectionState } from './WsClient';

const WsContext = createContext<WsClient | null>(null);

/** Owns the single WsClient; connects while logged in, disconnects on logout. */
export function WsProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new WsClient());
  const { session } = useAuth();
  const loggedIn = session !== null;

  useEffect(() => {
    if (loggedIn) client.start();
    else client.stop();
  }, [client, loggedIn]);

  useEffect(() => () => client.stop(), [client]);

  return <WsContext.Provider value={client}>{children}</WsContext.Provider>;
}

function useWsClient(): WsClient {
  const client = useContext(WsContext);
  if (!client) throw new Error('useWsClient must be used inside <WsProvider>');
  return client;
}

/** Subscribe to one WS event type. The handler may change between renders. */
export function useWsEvent<T extends WsEventType>(type: T, handler: (payload: WsEventMap[T]) => void) {
  const client = useWsClient();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => client.on(type, (payload) => ref.current(payload)), [client, type]);
}

/** Called after the socket re-authenticates following a disconnect. */
export function useResync(handler: () => void) {
  const client = useWsClient();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => client.onResync(() => ref.current()), [client]);
}

export function useConnectionState(): ConnectionState {
  const client = useWsClient();
  const [state, setState] = useState(client.getState());
  useEffect(() => {
    setState(client.getState());
    return client.onStateChange(setState);
  }, [client]);
  return state;
}
