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
            <th>ID</th>
            <th>网关群 ID</th>
            <th>状态</th>
            <th>成员数</th>
            <th>Agent</th>
            <th>自动踢人</th>
          </tr>
        </thead>
        <tbody>
          {groups.data?.map((g) => (
            <tr key={g.id}>
              <td><Link to={`/groups/${g.id}`}>{g.id}</Link></td>
              <td>{g.gatewayGroupId ?? '—'}</td>
              <td><StatusBadge status={g.status} /></td>
              <td>{g.members.length}</td>
              <td>{g.agentEnabled ? '开' : '关'}</td>
              <td>{g.autoKickEnabled ? '开' : '关'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {groups.data?.length === 0 && <p className="muted">暂无群组</p>}
    </section>
  );
}

function CreateGroupForm({ onCreated }: { onCreated: () => void }) {
  const accounts = useAsync(accountsApi.list, []);
  const [creatorId, setCreatorId] = useState('');
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [submitError, setSubmitError] = useState<unknown>(null);
  const job = useJob(onCreated);

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

  return (
    <form className="card" onSubmit={onSubmit}>
      <h3>创建群组</h3>
      <ErrorText error={accounts.error} />
      <label>
        群主账号
        <select value={creatorId} onChange={(e) => setCreatorId(e.target.value)} required>
          <option value="">— 选择 —</option>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>{label(a)}</option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>成员账号</legend>
        {accounts.data
          ?.filter((a) => a.id !== creatorId)
          .map((a) => (
            <label key={a.id} className="inline">
              <input type="checkbox" checked={memberIds.has(a.id)} onChange={() => toggleMember(a.id)} />
              {label(a)}
            </label>
          ))}
      </fieldset>
      <button type="submit" disabled={!creatorId || running}>创建</button>
      <ErrorText error={submitError} />
      <JobProgress label="建群" job={job.job} pollError={job.pollError} />
    </form>
  );
}
