import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { groupsApi } from '../api/endpoints';
import type { Group } from '../api/types';
import { AdminOnly, useAuth } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';
import { JobProgress } from '../components/JobProgress';
import { MessageTimeline } from '../components/MessageTimeline';
import { StatusBadge } from '../components/StatusBadge';
import { formatTime } from '../domain/format';
import { useAsync } from '../hooks/useAsync';
import { useJob } from '../hooks/useJob';
import { useResync, useWsEvent } from '../ws/WsProvider';

export function GroupDetailPage() {
  const { groupId = '' } = useParams();
  const group = useAsync(() => groupsApi.get(groupId), [groupId]);
  const agentRuns = useAsync(() => groupsApi.agentRuns(groupId), [groupId]);
  const sequenceRuns = useAsync(() => groupsApi.sequenceRuns(groupId), [groupId]);

  const isThisGroup = (p: { groupId: string }) => p.groupId === groupId;
  useWsEvent('group_changed', (p) => {
    if (isThisGroup(p)) group.reload();
  });
  useWsEvent('member_changed', (p) => {
    if (isThisGroup(p)) group.reload();
  });
  useWsEvent('agent_run', (p) => {
    if (!isThisGroup(p)) return;
    agentRuns.reload();
    group.reload(); // activeAgentRunId may have changed
  });
  useWsEvent('sequence_run', (p) => {
    if (!isThisGroup(p)) return;
    sequenceRuns.reload();
    group.reload(); // activeSequenceRunId may have changed
  });
  useResync(() => {
    group.reload();
    agentRuns.reload();
    sequenceRuns.reload();
  });

  const g = group.data;
  return (
    <section>
      <p><Link to="/groups">← 群组列表</Link></p>
      <ErrorText error={group.error} />
      {g && (
        <>
          <GroupHeader group={g} onChanged={group.reload} />

          <h3>成员</h3>
          <table>
            <thead>
              <tr><th>账号 ID</th><th>平台用户 ID</th><th>角色</th></tr>
            </thead>
            <tbody>
              {g.members.map((m) => (
                <tr key={m.accountId}>
                  <td><code>{m.accountId}</code></td>
                  <td>{m.platformUserId ?? '—'}</td>
                  <td>{m.role}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>消息</h3>
          <MessageTimeline key={g.id} groupId={g.id} members={g.members} canSend={g.status === 'active'} />
        </>
      )}

      <h3>Agent 运行</h3>
      <ErrorText error={agentRuns.error} />
      <table>
        <thead>
          <tr><th>Run</th><th>状态</th><th>结束原因</th><th>摘要</th><th>创建时间</th></tr>
        </thead>
        <tbody>
          {agentRuns.data?.map((r) => (
            <tr key={r.id} className={r.status === 'blocked' ? 'row-blocked' : undefined}>
              <td><Link to={`/agent-runs/${r.id}`}>{r.id}</Link></td>
              <td><StatusBadge status={r.status} /></td>
              <td>{r.endReason ?? '—'}</td>
              <td>{r.summary ?? '—'}</td>
              <td>{formatTime(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {agentRuns.data?.length === 0 && <p className="muted">暂无运行记录</p>}

      <h3>
        话术序列运行
        <AdminOnly>
          {' '}<Link className="btn-small" to={`/groups/${groupId}/sequence`}>启动序列</Link>
        </AdminOnly>
      </h3>
      <ErrorText error={sequenceRuns.error} />
      <table>
        <thead>
          <tr><th>Run</th><th>序列</th><th>状态</th><th>当前步骤</th><th>创建时间</th></tr>
        </thead>
        <tbody>
          {sequenceRuns.data?.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/sequence-runs/${r.id}`}>{r.id}</Link></td>
              <td>{r.sequenceId}</td>
              <td><StatusBadge status={r.status} /></td>
              <td>{r.currentStepIndex}</td>
              <td>{formatTime(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sequenceRuns.data?.length === 0 && <p className="muted">暂无运行记录</p>}
    </section>
  );
}

function GroupHeader({ group, onChanged }: { group: Group; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const leaveJob = useJob(onChanged);

  const patch = async (change: { agentEnabled?: boolean; autoKickEnabled?: boolean }) => {
    setSaving(true);
    setError(null);
    try {
      await groupsApi.patch(group.id, change);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
      onChanged();
    }
  };

  const leaveAll = async () => {
    if (!window.confirm('确认让所有账号退出该群？')) return;
    setError(null);
    try {
      const { jobId } = await groupsApi.leaveAll(group.id);
      leaveJob.track(jobId);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="card group-header">
      <h2>
        群 {group.id} <StatusBadge status={group.status} />
      </h2>
      <div className="kv">
        <span>网关群 ID</span><span>{group.gatewayGroupId ?? '—'}</span>
        <span>群主账号</span><span><code>{group.creatorAccountId}</code></span>
        <span>进行中 Agent</span>
        <span>{group.activeAgentRunId ? <Link to={`/agent-runs/${group.activeAgentRunId}`}>{group.activeAgentRunId}</Link> : '—'}</span>
        <span>进行中序列</span>
        <span>{group.activeSequenceRunId ? <Link to={`/sequence-runs/${group.activeSequenceRunId}`}>{group.activeSequenceRunId}</Link> : '—'}</span>
      </div>
      {isAdmin ? (
        <div className="toggles">
          <label className="inline">
            <input
              type="checkbox"
              checked={group.agentEnabled}
              disabled={saving}
              onChange={(e) => patch({ agentEnabled: e.target.checked })}
            />
            Agent 自动回复
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={group.autoKickEnabled}
              disabled={saving}
              onChange={(e) => patch({ autoKickEnabled: e.target.checked })}
            />
            自动踢人
          </label>
          <button className="danger" onClick={leaveAll} disabled={group.status === 'left' || leaveJob.job?.status === 'running'}>
            全部退群
          </button>
        </div>
      ) : (
        <div className="toggles muted">
          Agent 自动回复：{group.agentEnabled ? '开' : '关'} · 自动踢人：{group.autoKickEnabled ? '开' : '关'}
        </div>
      )}
      <ErrorText error={error} />
      <JobProgress label="退群" job={leaveJob.job} pollError={leaveJob.pollError} />
    </div>
  );
}
