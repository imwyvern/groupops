import { unresolvedPlaceholder } from '../domain/sequences';
import { ErrorText } from './ErrorText';

/** Shows UNRESOLVED_PLACEHOLDER prominently (which step, which key); other errors as "code: message". */
export function PlaceholderError({ error }: { error: unknown }) {
  if (!error) return null;
  const detail = unresolvedPlaceholder(error);
  if (!detail) return <ErrorText error={error} />;
  return (
    <div className="placeholder-error">
      <strong>占位符未解析</strong>
      <div>
        步骤 <span className="big">#{String(detail.stepIndex)}</span> 缺少变量{' '}
        <span className="big"><code>{String(detail.key)}</code></span>
      </div>
      <ErrorText error={error} />
    </div>
  );
}
