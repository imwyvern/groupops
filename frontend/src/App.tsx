import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { AccountsPage } from './pages/AccountsPage';
import { AgentRunPage } from './pages/AgentRunPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { GroupsPage } from './pages/GroupsPage';
import { LoginPage } from './pages/LoginPage';
import { SequenceRunPage } from './pages/SequenceRunPage';
import { SequenceStartPage } from './pages/SequenceStartPage';
import { WsProvider } from './ws/WsProvider';

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <p className="muted center">加载中…</p>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  return useAuth().isAdmin ? <>{children}</> : <Navigate to="/groups" replace />;
}

export function App() {
  return (
    <AuthProvider>
      <WsProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/groups" replace />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/groups" element={<GroupsPage />} />
              <Route path="/groups/:groupId" element={<GroupDetailPage />} />
              <Route
                path="/groups/:groupId/sequence"
                element={
                  <RequireAdmin>
                    <SequenceStartPage />
                  </RequireAdmin>
                }
              />
              <Route path="/agent-runs/:runId" element={<AgentRunPage />} />
              <Route path="/sequence-runs/:runId" element={<SequenceRunPage />} />
              <Route path="*" element={<Navigate to="/groups" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </WsProvider>
    </AuthProvider>
  );
}
