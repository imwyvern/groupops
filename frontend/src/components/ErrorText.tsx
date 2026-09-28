import { formatError } from '../api/client';

/** Renders an error as "CODE: message", or nothing when there is no error. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const text = typeof error === 'string' ? error : formatError(error);
  return <div className="error">{text}</div>;
}
