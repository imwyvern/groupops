import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { accountsApi, groupsApi } from '../api/endpoints';
import type { Account } from '../api/types';
import { AdminOnly } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';
import { JobProgress } from '../components/JobProgress';
import { StatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { useJob } from '../hooks/useJob';
import { useResync, useWsEvent } from '../ws/WsProvider';

export function GroupsPage() {
  const groups = useAsync(groupsApi.list, []);

  useWsEvent('group_changed', groups.reload);
  useWsEvent('member_changed', groups.reload);
  useResync(groups.reload);

  return (
    <section>
      <h2>群组</h2>
      <AdminOnly>
        <CreateGroupForm onCreated={groups.reload} />
      </AdminOnly>
      <ErrorText error={groups.error} />
      <table>
        <thead>
          <tr>
            <th>群</th>
            <th>状态</th>
            <th>成员数</th>
            <th>Agent</th>
            <th>自动踢人</th>
          </tr>
        </thead>
        <tbody>
          {groups.data?.map((g) => (
            <tr key={g.id}>
              <td><Link to={`/groups/${g.id}`}>{g.gatewayGroupId ?? '（创建中）'}</Link> <span className="muted small">{g.id.slice(0, 8)}</span></td>
              <td><StatusBadge status={g.status} /></td>
              <td>{g.members.length}</td>
              <td>{g.agentEnabled ? '开' : '关'}</td>
              <td>{g.autoKickEnabled ? '开' : '关'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {groups.data?.length === 0 && <p className="muted">还没有群组。建群需要群主和成员账号都在线——先去 <Link to="/accounts">账号</Link> 页连接账号。</p>}
    </section>
  );
}

function CreateGroupForm({ onCreated }: { onCreated: () => void }) {
  const accounts = useAsync(accountsApi.list, []);
  const [creatorId, setCreatorId] = useState('');
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [submitError, setSubmitError] = useState<unknown>(null);
  const job = useJob((done) => {
    if (done.status === 'finished') { setCreatorId(''); setMemberIds(new Set()); }
    accounts.reload();
    onCreated();
  });

  const toggleMember = (id: string) =>
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    try {
      const members = [...memberIds].filter((id) => id !== creatorId);
      const { jobId } = await groupsApi.create(creatorId, members);
      job.track(jobId);
    } catch (err) {
      setSubmitError(err);
    }
  };

  const running = job.job?.status === 'running';
  const label = (a: Account) => `${a.id}${a.platformUserId ? ` (${a.platformUserId})` : ''} · ${a.status}`;
  // The server requires every account to be online (422 otherwise) — say so up front instead of after submit.
  const online = (a: Account) => a.status === 'online';
  const onlineCount = accounts.data?.filter(online).length ?? 0;

  return (
    <form className="card" onSubmit={onSubmit}>
      <h3>创建群组</h3>
      <ErrorText error={accounts.error} />
      {accounts.data && onlineCount < 2 && (
        <p className="banner banner-info">建群至少需要 2 个在线账号（1 个群主 + 1 个成员），当前在线 {onlineCount} 个。去 <Link to="/accounts">账号</Link> 页点「重连」。</p>
      )}
      <p className="muted small">第一个勾选的成员会被提升为管理员（admin）。</p>
      <label>
        群主账号
        <select value={creatorId} onChange={(e) => setCreatorId(e.target.value)} required>
          <option value="">— 选择 —</option>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id} disabled={!online(a)}>{label(a)}</option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>成员账号</legend>
        {accounts.data
          ?.filter((a) => a.id !== creatorId)
          .map((a) => (
            <label key={a.id} className="inline">
              <input type="checkbox" checked={memberIds.has(a.id)} onChange={() => toggleMember(a.id)} disabled={!online(a)} />
              <span className={online(a) ? undefined : 'muted'}>{label(a)}</span>
            </label>
          ))}
      </fieldset>
      <button type="submit" disabled={!creatorId || running}>创建</button>
      <ErrorText error={submitError} />
      <JobProgress label="建群" job={job.job} pollError={job.pollError} />
      {job.job?.status === 'finished' && job.job.groupId && (
        <p>群已建好 → <Link to={`/groups/${job.job.groupId}`}>打开群详情</Link></p>
      )}
    </form>
  );
}
