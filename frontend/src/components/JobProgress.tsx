import type { Job } from '../api/types';
import { ErrorText } from './ErrorText';
import { StatusBadge } from './StatusBadge';

export function JobProgress({ label, job, pollError }: { label: string; job: Job | null; pollError: string | null }) {
  if (!job && !pollError) return null;
  return (
    <div className="job">
      <span>{label}任务：</span>
      <StatusBadge status={job?.status} />
      {job && job.errors.length > 0 && (
        <ul className="job-errors">
          {job.errors.map((e, i) => (
            <li key={i}>
              <code>{e.step}</code> → <code>{e.code}</code>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={pollError} />
    </div>
  );
}
