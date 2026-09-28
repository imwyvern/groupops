import { useState } from 'react';
import { accountsApi } from '../api/endpoints';
import type { Account } from '../api/types';
import { AdminOnly } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';
import { StatusBadge } from '../components/StatusBadge';
import { accountActions, type AccountAction } from '../domain/accounts';
import { formatTime } from '../domain/format';
import { useAsync } from '../hooks/useAsync';
import { useResync, useWsEvent } from '../ws/WsProvider';

export function AccountsPage() {
  const accounts = useAsync(accountsApi.list, []);
  const [actionError, setActionError] = useState<unknown>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useWsEvent('account_status_changed', accounts.reload);
  useWsEvent('account_terminal', accounts.reload);
  useResync(accounts.reload);

  const run = async (account: Account, action: AccountAction) => {
    setPendingId(account.id);
    setActionError(null);
    try {
      if (action.kind === 'connect') {
        await accountsApi.connect(account.id);
      } else {
        // expectedFrom = what the operator is looking at; server rejects with CAS_CONFLICT if stale.
        await accountsApi.transition(account.id, action.to, account.status);
      }
    } catch (err) {
      setActionError(err);
    } finally {
      setPendingId(null);
      accounts.reload();
    }
  };

  return (
    <section>
      <h2>账号</h2>
      <ErrorText error={accounts.error} />
      <ErrorText error={actionError} />
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>状态</th>
            <th>平台用户 ID</th>
            <th>限流至</th>
            <AdminOnly><th>操作</th></AdminOnly>
          </tr>
        </thead>
        <tbody>
          {accounts.data?.map((a) => (
            <tr key={a.id}>
              <td><code>{a.id}</code></td>
              <td><StatusBadge status={a.status} /></td>
              <td>{a.platformUserId ?? '—'}</td>
              <td>{formatTime(a.rateLimitedUntil)}</td>
              <AdminOnly>
                <td className="actions">
                  {accountActions(a.status).map((action) => (
                    <button key={action.label} disabled={pendingId === a.id} onClick={() => run(a, action)}>
                      {action.label}
                    </button>
                  ))}
                </td>
              </AdminOnly>
            </tr>
          ))}
        </tbody>
      </table>
      {accounts.loading && !accounts.data && <p className="muted">加载中…</p>}
    </section>
  );
}
