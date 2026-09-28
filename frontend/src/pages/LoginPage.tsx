import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, type Location } from 'react-router-dom';
import { login } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';

export function LoginPage() {
  const { session } = useAuth();
  const from = (useLocation().state as { from?: Location } | null)?.from?.pathname ?? '/groups';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={from} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      // Session change re-renders this page, which redirects above.
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={onSubmit}>
        <h2>GroupOps 登录</h2>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        <label>
          密码
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
        <ErrorText error={error} />
      </form>
    </div>
  );
}
