type Tone = 'green' | 'blue' | 'yellow' | 'red' | 'gray';

// One palette for every status enum in the app (accounts, groups, runs, delivery).
const TONES: Record<string, Tone> = {
  online: 'green',
  active: 'green',
  finished: 'green',
  sent: 'green',
  accepted: 'blue',
  running: 'blue',
  queued: 'yellow',
  pending: 'yellow',
  rate_limited: 'yellow',
  unreachable: 'yellow',
  unknown: 'yellow',
  failed: 'red',
  blocked: 'red',
  suspended: 'red',
  session_expired: 'red',
  idle: 'gray',
  disconnected: 'gray',
  left: 'gray',
  cancelled: 'gray',
  stopped: 'gray',
  skipped: 'gray',
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge badge-gray">—</span>;
  return <span className={`badge badge-${TONES[status] ?? 'gray'}`}>{status}</span>;
}
