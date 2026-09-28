import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { sequencesApi } from '../api/endpoints';
import { ErrorText } from '../components/ErrorText';
import { StatusBadge } from '../components/StatusBadge';
import { VarList } from '../components/VarList';
import { formatTime } from '../domain/format';
import { useAsync } from '../hooks/useAsync';
import { useResync, useWsEvent } from '../ws/WsProvider';

const POLL_MS = 2000;

/** Live progress of one sequence run: WS `sequence_run` events, plus a poll while running as a safety net. */
export function SequenceRunPage() {
  const { runId = '' } = useParams();
  const run = useAsync(() => sequencesApi.getRun(runId), [runId]);
  const sequences = useAsync(sequencesApi.list, []);

  useWsEvent('sequence_run', (p) => {
    if (p.runId === runId) run.reload();
  });
  useWsEvent('message_status', (p) => {
    if (p.groupId === run.data?.groupId) run.reload();
  });
  useResync(run.reload);

  const running = run.data?.status === 'running';
  const { reload } = run;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(t);
  }, [running, reload]);

  const r = run.data;
  const definition = sequences.data?.find((s) => s.id === r?.sequenceId);
  const stepText = (index: number) => definition?.steps.find((s) => s.index === index)?.text;

  return (
    <section>
      {r && <p><Link to={`/groups/${r.groupId}`}>← 群 {r.groupId}</Link></p>}
      <h2>序列运行 {runId}</h2>
      <ErrorText error={run.error} />
      {r && (
        <>
          <div className="card kv">
            <span>序列</span><span>{definition?.name ?? r.sequenceId}</span>
            <span>状态</span><span><StatusBadge status={r.status} /></span>
            <span>当前步骤</span><span>{r.currentStepIndex}</span>
          </div>
          <table>
            <thead>
              <tr><th>#</th><th>文本模板</th><th>状态</th><th>计划时间</th><th>发送时间</th><th>变量（来源）</th></tr>
            </thead>
            <tbody>
              {r.steps.map((s) => (
                <tr key={s.index} className={s.index === r.currentStepIndex && running ? 'row-current' : undefined}>
                  <td>{s.index}</td>
                  <td>{stepText(s.index) ?? '—'}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{formatTime(s.scheduledAt)}</td>
                  <td>{formatTime(s.sentAt)}</td>
                  <td><VarList vars={s.resolvedVars ?? {}} sources={s.varSources ?? {}} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
