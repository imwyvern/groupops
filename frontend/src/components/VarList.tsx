import type { Vars } from '../api/types';

/** Resolved variables with where each value came from (`default` or `step:N`). */
export function VarList({ vars, sources }: { vars: Vars; sources: Record<string, string> }) {
  const keys = Object.keys(vars);
  if (keys.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="var-list">
      {keys.map((k) => (
        <li key={k}>
          <code>{k}</code> = {vars[k]}{' '}
          <span className={`source ${sources[k]?.startsWith('step:') ? 'source-step' : ''}`}>{sources[k] ?? '?'}</span>
        </li>
      ))}
    </ul>
  );
}
