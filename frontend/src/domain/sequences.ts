import { ApiError } from '../api/client';
import type { SequenceStepDef, StepVars, Vars } from '../api/types';

export interface VarRow {
  key: string;
  value: string;
}

export function rowsToVars(rows: VarRow[]): Vars {
  const vars: Vars = {};
  for (const { key, value } of rows) {
    if (key.trim()) vars[key.trim()] = value;
  }
  return vars;
}

/** Parse the stepVars textarea: `{ "<stepIndex>": { "<key>": "<value>" } }`. Empty → {}. */
export function parseStepVars(text: string): StepVars {
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed)) throw new Error('stepVars 必须是对象，如 {"2":{"location":"…"}}');
  for (const [step, vars] of Object.entries(parsed)) {
    if (!/^\d+$/.test(step)) throw new Error(`stepVars 的键必须是步骤序号，收到 "${step}"`);
    if (!isPlainObject(vars) || !Object.values(vars).every((v) => typeof v === 'string')) {
      throw new Error(`stepVars["${step}"] 必须是 { key: "字符串" }`);
    }
  }
  return parsed as StepVars;
}

/** Parse the "create sequence" JSON: `{ name, steps: [{ index, accountRole, text, delaySeconds }] }`. */
export function parseSequenceJson(text: string): { name: string; steps: SequenceStepDef[] } {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed) || typeof parsed.name !== 'string' || !Array.isArray(parsed.steps)) {
    throw new Error('需要 { "name": string, "steps": [...] }');
  }
  return { name: parsed.name, steps: parsed.steps as SequenceStepDef[] };
}

/** Details of a 422 UNRESOLVED_PLACEHOLDER, if that's what `err` is. */
export function unresolvedPlaceholder(err: unknown): { stepIndex: unknown; key: unknown } | null {
  if (err instanceof ApiError && err.code === 'UNRESOLVED_PLACEHOLDER') {
    return { stepIndex: err.extra.stepIndex, key: err.extra.key };
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
