import type { AccountStatus } from '../api/types';

export type AccountAction =
  | { kind: 'transition'; label: string; to: AccountStatus }
  | { kind: 'connect'; label: string };

const MARK_OFFLINE: AccountAction = { kind: 'transition', label: '标记离线', to: 'disconnected' };
const RECONNECT: AccountAction = { kind: 'connect', label: '重连' };
const RELEASE: AccountAction = { kind: 'transition', label: '释放账号', to: 'idle' };

/**
 * Operator actions that are legal from a given status. The server remains the
 * authority (it may still answer 409 ILLEGAL_TRANSITION / CAS_CONFLICT); this
 * only keeps illegal buttons off the screen.
 */
export function accountActions(status: AccountStatus): AccountAction[] {
  switch (status) {
    case 'online':
      return [MARK_OFFLINE, RELEASE];
    case 'rate_limited':
      return [MARK_OFFLINE];
    case 'disconnected':
      return [RECONNECT, RELEASE];
    case 'idle':
      return [RECONNECT];
    case 'suspended':
    case 'session_expired':
      return [];
  }
}
