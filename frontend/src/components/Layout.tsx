import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { logout } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useConnectionState } from '../ws/WsProvider';
import { Notifications } from './Notifications';

const CONNECTION_LABEL = { open: '实时已连接', connecting: '连接中…', closed: '已断开' } as const;

export function Layout() {
  const { session } = useAuth();
  const conn = useConnectionState();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="app">
      <header className="topbar">
        <strong>GroupOps</strong>
        <nav>
          <NavLink to="/accounts">账号</NavLink>
          <NavLink to="/groups">群组</NavLink>
        </nav>
        <span className="spacer" />
        <span className={`conn conn-${conn}`}>● {CONNECTION_LABEL[conn]}</span>
        <span className="user">
          {session?.username} <span className="muted">({session?.role})</span>
        </span>
        <button className="btn-link" onClick={onLogout}>退出</button>
      </header>
      <Notifications />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
