import { useCallback, useEffect, useRef, useState } from 'react';
import { formatError } from '../api/client';
import { jobsApi } from '../api/endpoints';
import type { Job } from '../api/types';

const POLL_MS = 1000;

export interface JobTracker {
  job: Job | null;
  pollError: string | null;
  track: (jobId: string) => void;
}

/** Polls GET /jobs/:id every second until the job is no longer `running`. */
export function useJob(onDone?: (job: Job) => void): JobTracker {
  const [job, setJob] = useState<Job | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const track = useCallback((jobId: string) => {
    cancel();
    setJob({ status: 'running', errors: [] });
    setPollError(null);

    const poll = async () => {
      try {
        const next = await jobsApi.get(jobId);
        setJob(next);
        if (next.status === 'running') {
          timer.current = window.setTimeout(poll, POLL_MS);
        } else {
          timer.current = null;
          onDoneRef.current?.(next);
        }
      } catch (err) {
        setPollError(formatError(err));
        timer.current = null;
      }
    };
    void poll();
  }, []);

  useEffect(() => cancel, []);

  return { job, pollError, track };
}
