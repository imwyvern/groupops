// A single shared WebSocket connection with auth handshake, seq-based
// dedupe/resume, and exponential-backoff reconnect.
//
// Guarantees offered to subscribers:
//   * every frame is delivered at most once (frames with seq <= lastSeq are dropped);
//   * after a reconnect the server is asked to replay from `sinceSeq: lastSeq`,
//     and `resync` listeners fire so pages can re-fetch their visible data —
//     this covers anything the replay might not (e.g. server restarted).

import { refreshAccessToken } from '../api/client';
import { tokenStore } from '../api/tokenStore';
import type { WsEventMap, WsEventType } from '../api/types';

export type ConnectionState = 'connecting' | 'open' | 'closed';

type Handler<T extends WsEventType> = (payload: WsEventMap[T], seq: number) => void;
type AnyHandler = (payload: unknown, seq: number) => void;

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 3000;

export class WsClient {
  private socket: WebSocket | null = null;
  private lastSeq = 0;
  private attempt = 0;
  private everAuthenticated = false;
  private reconnectTimer: number | null = null;
  private stopped = true;

  private readonly handlers = new Map<string, Set<AnyHandler>>();
  private readonly resyncListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private state: ConnectionState = 'closed';

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Close for good (logout). Resets seq so the next login starts fresh. */
  stop() {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.lastSeq = 0;
    this.attempt = 0;
    this.everAuthenticated = false;
    this.setState('closed');
  }

  getState() {
    return this.state;
  }

  on<T extends WsEventType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as AnyHandler);
    return () => set!.delete(handler as AnyHandler);
  }

  onResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  onStateChange(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  // -------------------------------------------------------------------------

  private setState(s: ConnectionState) {
    if (this.state === s) return;
    this.state = s;
    this.stateListeners.forEach((l) => l(s));
  }

  private connect() {
    if (this.stopped) return;
    this.setState('connecting');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      const hello: Record<string, unknown> = { type: 'auth', accessToken: tokenStore.getToken() };
      if (this.lastSeq > 0) hello.sinceSeq = this.lastSeq;
      socket.send(JSON.stringify(hello));
    };

    socket.onmessage = (ev) => {
      let frame: { type?: string; seq?: number; success?: boolean; payload?: unknown };
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (frame.type === 'auth') {
        this.handleAuthReply(socket, frame.success === true);
        return;
      }
      this.dispatch(frame);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return; // superseded socket
      this.socket = null;
      this.setState('closed');
      this.scheduleReconnect();
    };
    // onerror is always followed by onclose; nothing to do here.
  }

  private handleAuthReply(socket: WebSocket, success: boolean) {
    if (!success) {
      // Token likely expired: refresh via the shared single-flight path, then reconnect.
      this.socket = null;
      socket.close();
      this.setState('connecting');
      refreshAccessToken().then(
        () => this.connect(),
        () => this.stop(), // refresh failed: session is cleared, router goes to /login
      );
      return;
    }
    this.attempt = 0;
    this.setState('open');
    if (this.everAuthenticated) {
      this.resyncListeners.forEach((l) => l());
    }
    this.everAuthenticated = true;
  }

  private dispatch(frame: { type?: string; seq?: number; payload?: unknown }) {
    if (typeof frame.seq === 'number') {
      if (frame.seq <= this.lastSeq) return; // duplicate (replay overlap)
      this.lastSeq = frame.seq;
    }
    if (!frame.type) return;
    this.handlers.get(frame.type)?.forEach((h) => {
      try {
        h(frame.payload, frame.seq ?? 0);
      } catch (err) {
        console.error('ws handler failed', err);
      }
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    this.attempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
