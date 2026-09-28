import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { agentRunsApi } from '../api/endpoints';
import type { AgentStep } from '../api/types';
import { ErrorText } from '../components/ErrorText';
import { StatusBadge } from '../components/StatusBadge';
import { prettyJson } from '../domain/format';
import { useAsync } from '../hooks/useAsync';
import { useResync, useWsEvent } from '../ws/WsProvider';

export function AgentRunPage() {
  const { runId = '' } = useParams();
  const run = useAsync(() => agentRunsApi.get(runId), [runId]);

  useWsEvent('agent_step', (p) => {
    if (p.runId === runId) run.reload();
  });
  useWsEvent('agent_run', (p) => {
    if (p.runId === runId) run.reload();
  });
  useResync(run.reload);

  const r = run.data;
  return (
    <section>
      {r && <p><Link to={`/groups/${r.groupId}`}>← 群 {r.groupId}</Link></p>}
      <h2>Agent 运行 {runId}</h2>
      <ErrorText error={run.error} />
      {r && (
        <>
          <div className={`card ${r.status === 'blocked' ? 'card-blocked' : ''}`}>
            <div className="kv">
              <span>状态</span><span><StatusBadge status={r.status} /></span>
              <span>结束原因</span><span>{r.endReason ?? '—'}</span>
              <span>摘要</span><span>{r.summary ?? '—'}</span>
            </div>
          </div>
          <table className="steps">
            <thead>
              <tr>
                <th>#</th><th>类型</th><th>工具</th><th>输入</th><th>结果摘要</th><th>审计结论</th><th>错误</th>
              </tr>
            </thead>
            <tbody>
              {r.steps.map((step, i) => (
                <StepRow key={`${i}-${step.toolUseId ?? ''}`} index={i + 1} step={step} />
              ))}
            </tbody>
          </table>
          {r.steps.length === 0 && <p className="muted">暂无步骤</p>}
        </>
      )}
    </section>
  );
}

function StepRow({ index, step }: { index: number; step: AgentStep }) {
  const [showRaw, setShowRaw] = useState(false);
  const failed = step.isError || step.kind === 'protocol_error';

  return (
    <>
      <tr className={failed ? 'row-error' : undefined}>
        <td>{index}</td>
        <td><code>{step.kind}</code></td>
        <td>{step.name ?? '—'}</td>
        <td>
          {step.input === null || step.input === undefined ? (
            '—'
          ) : (
            <details>
              <summary>展开</summary>
              <pre>{prettyJson(step.input)}</pre>
            </details>
          )}
        </td>
        <td>{step.resultSummary ?? '—'}</td>
        <td>{step.auditVerdict ?? '—'}</td>
        <td>
          {step.isError ? <code className="fail-code">{step.errorCode ?? 'ERROR'}</code> : '—'}
          {step.kind === 'protocol_error' && (
            <div>
              <button className="btn-link" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? '收起原始响应' : '查看原始响应'}
              </button>
            </div>
          )}
        </td>
      </tr>
      {showRaw && (
        <tr className="raw-row">
          <td colSpan={7}>
            <pre>{step.rawResponse ?? '(空)'}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
