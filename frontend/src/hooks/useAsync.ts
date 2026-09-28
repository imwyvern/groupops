import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Run an async loader when `deps` change; `reload()` re-runs it.
 * Results from superseded calls are discarded, so out-of-order responses
 * (or StrictMode double effects) can't overwrite newer data.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const callId = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(() => {
    const id = ++callId.current;
    setLoading(true);
    loaderRef.current().then(
      (value) => {
        if (id !== callId.current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err) => {
        if (id !== callId.current) return;
        setError(err);
        setLoading(false);
      },
    );
  }, []);

  useEffect(run, deps); // deps are supplied by the caller

  return { data, error, loading, reload: run };
}
