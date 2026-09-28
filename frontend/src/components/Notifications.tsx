import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWsEvent } from '../ws/WsProvider';

interface Toast {
  id: number;
  title: string;
  body: string;
  link?: string;
}

let nextId = 1;

/**
 * Global banner stack for events an operator must not miss:
 * data inconsistencies, accounts reaching a terminal status, and blocked agent runs.
 * Toasts stay until dismissed.
 */
export function Notifications() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    setToasts((prev) => [...prev, { ...t, id: nextId++ }]);
  }, []);
  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  useWsEvent('inconsistency', (p) =>
    push({ title: `数据不一致 · ${p.kind}`, body: `${p.ref}: ${p.message}` }),
  );
  useWsEvent('account_terminal', (p) =>
    push({ title: '账号进入终止状态', body: `${p.accountId} → ${p.status}`, link: '/accounts' }),
  );
  useWsEvent('agent_run', (p) => {
    if (p.status !== 'blocked') return;
    push({
      title: 'Agent 运行被拦截',
      body: `run ${p.runId}（群 ${p.groupId}）${p.endReason ? `：${p.endReason}` : ''}`,
      link: `/agent-runs/${p.runId}`,
    });
  });

  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <div className="toast-title">
            {t.title}
            <button className="btn-link" onClick={() => dismiss(t.id)}>×</button>
          </div>
          <div>{t.body}</div>
          {t.link && <Link to={t.link}>查看</Link>}
        </div>
      ))}
    </div>
  );
}
