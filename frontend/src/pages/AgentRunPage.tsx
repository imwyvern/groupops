import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { agentRunsApi } from '../api/endpoints';
import type { AgentStep } from '../api/types';
import { ErrorText } from '../components/ErrorText';
import { StatusBadge } from '../components/StatusBadge';
import { formatTime, prettyJson } from '../domain/format';
import { useAsync } from '../hooks/useAsync';
import { useResync, useWsEvent } from '../ws/WsProvider';

const MAX_STEPS = 12;

/** Plain-language reading of endReason, so the operator doesn't need the spec to interpret a run. */
const END_REASON_TEXT: Record<string, string> = {
  final: 'Agent 自行结束',
  budget_exhausted: `用完 ${MAX_STEPS} 步上限，被强制结束`,
  wall_clock: '超过 60 秒时限，被强制结束',
  protocol_errors: 'Agent 连续 3 次返回无效响应，被强制结束',
  audit_blocked: '审计服务 3 次都没给出结论，待执行的操作已拦截，需要人工处理',
  cancelled: '群变为不可达或 Agent 被关闭，已在当前步之后停止',
};

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
      {r && <p><Link to={`/groups/${r.groupId}`}>← 返回群详情</Link></p>}
      <h2>Agent 运行 {runId}</h2>
      <ErrorText error={run.error} />
      {r && (
        <>
          {r.status === 'blocked' && (
            <div className="banner banner-danger">此运行已被拦截：审计服务没有给出结论，Agent 想执行的操作没有执行。请查看最后一步的输入并人工决定。</div>
          )}
          <div className={`card ${r.status === 'blocked' ? 'card-blocked' : ''}`}>
            <div className="kv">
              <span>状态</span><span><StatusBadge status={r.status} /></span>
              <span>结束原因</span>
              <span>{r.endReason ? <>{END_REASON_TEXT[r.endReason] ?? r.endReason} <code className="muted">{r.endReason}</code></> : '—'}</span>
              <span>步数</span><span>{r.steps.length} / {MAX_STEPS}</span>
              <span>摘要</span><span>{r.summary ?? '—'}</span>
            </div>
          </div>
          {r.triggerMessages && r.triggerMessages.length > 0 && (
            <>
              <h3>触发消息</h3>
              <div className="trigger-list">
                {r.triggerMessages.map((m) => (
                  <div key={m.msgId} className="msg">
                    <div className="msg-meta"><span className="msg-sender">{m.senderPlatformUserId}</span><span>{formatTime(m.sentAt)}</span></div>
                    <div className="msg-text">{m.text}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          <h3>步骤</h3>
          <table className="steps">
            <thead>
              <tr>
                <th>#</th><th>类型</th><th>工具</th><th>输入</th><th>结果摘要</th><th>审计结论</th><th>错误</th>
              </tr>
            </thead>
            <tbody>
              {r.steps.map((step, i) => (
                <StepRow key={`${i}-${step.toolUseId ?? ''}`} index={i + 1} step={step} runSummary={r.summary} />
              ))}
            </tbody>
          </table>
          {r.steps.length === 0 && <p className="muted">暂无步骤</p>}
        </>
      )}
    </section>
  );
}

function StepRow({ index, step, runSummary }: { index: number; step: AgentStep; runSummary: string | null }) {
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
        <td>{step.kind === 'final' ? <>结束：{runSummary ?? '—'}</> : step.resultSummary ?? '—'}</td>
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
