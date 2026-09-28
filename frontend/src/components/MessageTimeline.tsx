import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { formatError } from '../api/client';
import { groupsApi } from '../api/endpoints';
import type { GroupMember, Message } from '../api/types';
import { AdminOnly } from '../auth/AuthContext';
import { formatTime } from '../domain/format';
import { mergeMessages } from '../domain/messages';
import { useResync, useWsEvent } from '../ws/WsProvider';
import { ErrorText } from './ErrorText';
import { StatusBadge } from './StatusBadge';

/**
 * Message history for one group.
 *
 * Realtime strategy: on any `message` / `message_status` event for this group
 * (or a WS resync) we re-fetch the newest page and merge by row `id`. This is
 * idempotent, so duplicate or reordered events can never produce duplicate rows.
 * "加载更早" walks backwards with the cursor of the oldest page loaded so far.
 *
 * Render with `key={groupId}` so switching groups starts from clean state.
 */
export function MessageTimeline({ groupId, members, canSend }: { groupId: string; members: GroupMember[]; canSend: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  /** undefined = first page not loaded yet; null = no older pages. */
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Coalesce bursts of events: at most one latest-page fetch in flight, plus one queued.
  const inflight = useRef(false);
  const dirty = useRef(false);

  const refreshLatest = useCallback(async () => {
    if (inflight.current) {
      dirty.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        dirty.current = false;
        const page = await groupsApi.messages(groupId);
        setMessages((prev) => mergeMessages(prev, page.items));
        setOlderCursor((prev) => (prev === undefined ? page.nextCursor : prev));
        setError(null);
      } while (dirty.current);
    } catch (err) {
      // A refresh queued during the failed fetch is dropped; the next event or resync retries.
      setError(formatError(err));
    } finally {
      inflight.current = false;
    }
  }, [groupId]);

  useEffect(() => {
    void refreshLatest();
  }, [refreshLatest]);

  useWsEvent('message', (p) => {
    if (p.groupId === groupId) void refreshLatest();
  });
  useWsEvent('message_status', (p) => {
    if (p.groupId === groupId) void refreshLatest();
  });
  useResync(() => void refreshLatest());

  const loadOlder = async () => {
    if (!olderCursor) return;
    setLoadingOlder(true);
    try {
      const page = await groupsApi.messages(groupId, olderCursor);
      setMessages((prev) => mergeMessages(prev, page.items));
      setOlderCursor(page.nextCursor);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  // Keep the view pinned to the newest message when new ones arrive at the bottom.
  const listRef = useRef<HTMLDivElement>(null);
  const newestId = messages[messages.length - 1]?.id;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newestId]);

  return (
    <div className="timeline">
      <ErrorText error={error} />
      <div className="messages" ref={listRef}>
        {olderCursor && (
          <button className="btn-link" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? '加载中…' : '加载更早'}
          </button>
        )}
        {olderCursor === null && messages.length > 0 && <div className="muted center">— 没有更早的消息 —</div>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.isOwn ? 'msg-own' : ''}`}>
            <div className="msg-meta">
              <span>{m.senderPlatformUserId ?? '未知发送者'}</span>
              <span>{formatTime(m.sentAt)}</span>
              {m.isOwn && <StatusBadge status={m.deliveryStatus} />}
              {m.isOwn && m.failCode && <code className="fail-code">{m.failCode}</code>}
            </div>
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
        {messages.length === 0 && olderCursor !== undefined && <div className="muted center">暂无消息</div>}
      </div>
      {canSend && (
        <AdminOnly>
          <SendBox groupId={groupId} members={members} onSent={refreshLatest} />
        </AdminOnly>
      )}
    </div>
  );
}

function SendBox({ groupId, members, onSent }: { groupId: string; members: GroupMember[]; onSent: () => void }) {
  const [accountId, setAccountId] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await groupsApi.send(groupId, accountId, text);
      setText('');
      onSent();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="send-box" onSubmit={onSubmit}>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
        <option value="">发送账号…</option>
        {members.map((m) => (
          <option key={m.accountId} value={m.accountId}>
            {m.accountId}{m.platformUserId ? ` (${m.platformUserId})` : ''} · {m.role}
          </option>
        ))}
      </select>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="消息内容" required />
      <button type="submit" disabled={busy || !accountId || !text.trim()}>发送</button>
      <ErrorText error={error} />
    </form>
  );
}
