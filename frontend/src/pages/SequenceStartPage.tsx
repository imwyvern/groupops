import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { groupsApi, sequencesApi } from '../api/endpoints';
import type { PrecheckStep, StepVars, Vars } from '../api/types';
import { ErrorText } from '../components/ErrorText';
import { Modal } from '../components/Modal';
import { PlaceholderError } from '../components/PlaceholderError';
import { VarList } from '../components/VarList';
import { parseSequenceJson, parseStepVars, rowsToVars, type VarRow } from '../domain/sequences';
import { useAsync } from '../hooks/useAsync';

/** Admin-only page (route-guarded): pick a sequence, fill variables, precheck, start. */
export function SequenceStartPage() {
  const { groupId = '' } = useParams();
  const navigate = useNavigate();
  const sequences = useAsync(sequencesApi.list, []);

  const [sequenceId, setSequenceId] = useState('');
  const [rows, setRows] = useState<VarRow[]>([{ key: '', value: '' }]);
  const [stepVarsText, setStepVarsText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [precheck, setPrecheck] = useState<PrecheckStep[] | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = sequences.data?.find((s) => s.id === sequenceId);

  /** Validate local inputs; returns null (and shows why) if invalid. */
  const collectInputs = (): { vars: Vars; stepVars: StepVars } | null => {
    setInputError(null);
    setRequestError(null);
    try {
      return { vars: rowsToVars(rows), stepVars: parseStepVars(stepVarsText) };
    } catch (err) {
      setInputError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const runPrecheck = async () => {
    const input = collectInputs();
    if (!input) return;
    setBusy(true);
    try {
      const res = await sequencesApi.precheck(sequenceId, input.vars, input.stepVars);
      setPrecheck(res.steps);
    } catch (err) {
      setRequestError(err);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const input = collectInputs();
    if (!input) return;
    setBusy(true);
    try {
      const { runId } = await groupsApi.startSequenceRun(groupId, sequenceId, input.vars, input.stepVars);
      navigate(`/sequence-runs/${runId}`);
    } catch (err) {
      setRequestError(err);
      setBusy(false);
    }
  };

  const updateRow = (i: number, patch: Partial<VarRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <section>
      <p><Link to={`/groups/${groupId}`}>← 群 {groupId}</Link></p>
      <h2>启动话术序列</h2>
      <ErrorText error={sequences.error} />

      <div className="card">
        <label>
          序列
          <select value={sequenceId} onChange={(e) => { setSequenceId(e.target.value); setPrecheck(null); }}>
            <option value="">— 选择 —</option>
            {sequences.data?.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.steps.length} 步)</option>
            ))}
          </select>
        </label>

        {selected && (
          <table>
            <thead><tr><th>#</th><th>账号角色</th><th>文本</th><th>延迟(s)</th></tr></thead>
            <tbody>
              {selected.steps.map((s) => (
                <tr key={s.index}><td>{s.index}</td><td>{s.accountRole}</td><td>{s.text}</td><td>{s.delaySeconds}</td></tr>
              ))}
            </tbody>
          </table>
        )}

        <h4>vars（默认变量）</h4>
        {rows.map((row, i) => (
          <div key={i} className="var-row">
            <input placeholder="key" value={row.key} onChange={(e) => updateRow(i, { key: e.target.value })} />
            <input placeholder="value" value={row.value} onChange={(e) => updateRow(i, { value: e.target.value })} />
            <button className="btn-link" onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}>删除</button>
          </div>
        ))}
        <button className="btn-link" onClick={() => setRows((prev) => [...prev, { key: '', value: '' }])}>+ 添加变量</button>

        <h4>stepVars（按步骤覆盖，JSON）</h4>
        <textarea
          rows={4}
          value={stepVarsText}
          onChange={(e) => setStepVarsText(e.target.value)}
          placeholder={'{"2":{"location":"上海"}}'}
        />

        <div className="actions">
          <button onClick={runPrecheck} disabled={!sequenceId || busy}>预检</button>
          <button onClick={start} disabled={!sequenceId || busy}>启动</button>
        </div>
        <ErrorText error={inputError} />
        <PlaceholderError error={requestError} />
      </div>

      {precheck && (
        <Modal title="预检结果" onClose={() => setPrecheck(null)}>
          <PrecheckTable steps={precheck} />
          <div className="actions">
            <button onClick={() => { setPrecheck(null); void start(); }} disabled={busy}>确认启动</button>
          </div>
        </Modal>
      )}

      <CreateSequenceForm onCreated={(id) => { sequences.reload(); setSequenceId(id); }} />
    </section>
  );
}

function PrecheckTable({ steps }: { steps: PrecheckStep[] }) {
  return (
    <table>
      <thead><tr><th>#</th><th>最终文本</th><th>变量 = 值（来源）</th></tr></thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.index}>
            <td>{s.index}</td>
            <td>
              <div>{s.resolvedText}</div>
              <div className="muted small">{s.text}</div>
            </td>
            <td>
              <VarList vars={s.resolvedVars} sources={s.varSources} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SEQUENCE_EXAMPLE = `{
  "name": "欢迎话术",
  "steps": [
    { "index": 1, "accountRole": "creator", "text": "大家好，欢迎来到{{location}}", "delaySeconds": 0 },
    { "index": 2, "accountRole": "member", "text": "{{location}}见！", "delaySeconds": 30 }
  ]
}`;

function CreateSequenceForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setCreated(null);
    try {
      const { name, steps } = parseSequenceJson(text);
      const { id } = await sequencesApi.create(name, steps);
      setCreated(id);
      setText('');
      onCreated(id);
    } catch (err) {
      setError(err instanceof SyntaxError ? `INVALID_JSON: ${err.message}` : err);
    }
  };

  return (
    <details className="card">
      <summary>新建序列（粘贴 JSON）</summary>
      <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={SEQUENCE_EXAMPLE} />
      <div className="actions">
        <button onClick={submit} disabled={!text.trim()}>创建序列</button>
      </div>
      {created && <p className="ok">已创建序列 {created}</p>}
      <ErrorText error={error} />
    </details>
  );
}
