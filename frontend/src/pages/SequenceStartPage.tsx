import { useEffect, useRef, useState } from 'react';
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
  // A just-created sequence is selected (and its variables scaffolded) once the list has reloaded.
  const pendingSelect = useRef<string | null>(null);
  useEffect(() => {
    if (pendingSelect.current && sequences.data?.some((s) => s.id === pendingSelect.current)) {
      selectSequence(pendingSelect.current);
      pendingSelect.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequences.data]);

  /**
   * Picking a sequence pre-fills one var row per {placeholder} its steps use, keeping values
   * already typed. This is form scaffolding only — resolution (and stepVars precedence) is
   * done by the server's precheck, so the preview is exactly what will be sent.
   */
  const selectSequence = (id: string) => {
    setSequenceId(id);
    setPrecheck(null);
    const seq = sequences.data?.find((s) => s.id === id);
    if (!seq) return;
    const keys = [...new Set(seq.steps.flatMap((st) => [...st.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1])))];
    setRows((prev) => {
      const typed = new Map(prev.filter((r) => r.key).map((r) => [r.key, r.value]));
      const next = keys.map((key) => ({ key, value: typed.get(key) ?? '' }));
      return next.length ? next : [{ key: '', value: '' }];
    });
  };

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
      <p><Link to={`/groups/${groupId}`}>← 返回群详情</Link></p>
      <h2>启动话术序列</h2>
      <ErrorText error={sequences.error} />

      <div className="card">
        <label>
          序列
          <select value={sequenceId} onChange={(e) => selectSequence(e.target.value)}>
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

        {sequences.data?.length === 0 && <p className="banner banner-info">还没有序列。先在下方「新建序列」粘贴一份 JSON。</p>}
        <h4>vars（默认变量）</h4>
        {selected && <p className="muted small">已按序列里用到的占位符列出变量；留空的变量会在预检时指出是哪一步缺失。</p>}
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

      <CreateSequenceForm noSequences={sequences.data?.length === 0} onCreated={(id) => { pendingSelect.current = id; sequences.reload(); }} />
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
  "name": "活动提醒",
  "steps": [
    { "index": 1, "accountRole": "admin",  "text": "{event} 将于 {time} 开始，请提前准备", "delaySeconds": 10 },
    { "index": 2, "accountRole": "member", "text": "提醒：{event} 的资料已上传到 {location}", "delaySeconds": 5 }
  ]
}`;

function CreateSequenceForm({ onCreated, noSequences }: { onCreated: (id: string) => void; noSequences: boolean }) {
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
    <details className="card" open={noSequences}>
      <summary>新建序列（粘贴 JSON）</summary>
      <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={SEQUENCE_EXAMPLE} />
      <div className="actions">
        <button onClick={submit} disabled={!text.trim()}>创建序列</button>
        <button type="button" className="btn-link" onClick={() => setText(SEQUENCE_EXAMPLE)}>填入示例</button>
      </div>
      {created && <p className="ok">已创建序列 {created}</p>}
      <ErrorText error={error} />
    </details>
  );
}
