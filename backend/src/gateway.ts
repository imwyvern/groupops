import { config } from './config.js';

/** A gateway reply that was not 2xx. `code` is the gateway error code (e.g. RATE_LIMITED). */
export class GatewayError extends Error {
  constructor(public status: number, public code: string, public body: any) {
    super(`${status} ${code}`);
  }
  /** The request may or may not have taken effect. */
  get outcomeUnknown() { return this.code === 'NETWORK_TIMEOUT' || this.status === 504; }
}

async function call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(config.gatewayUrl + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    // Our own timeout or a dropped connection: from the caller's view the outcome is unknown.
    throw new GatewayError(504, 'NETWORK_TIMEOUT', { message: String(e?.message ?? e) });
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new GatewayError(res.status, data?.code ?? data?.error?.code ?? (res.status === 503 ? 'UNAVAILABLE' : `HTTP_${res.status}`), data);
  return { status: res.status, data };
}

export const gateway = {
  connect: (accountId: string) => call<{ platformUserId: string }>('POST', `/accounts/${enc(accountId)}/connect`),
  disconnect: (accountId: string) => call('POST', `/accounts/${enc(accountId)}/disconnect`),
  createGroup: (creatorAccountId: string) => call<{ groupId: string }>('POST', '/groups', { creatorAccountId }),
  invite: (gid: string) => call<{ inviteLink: string; readyAfterMs: number }>('POST', `/groups/${enc(gid)}/invite`),
  join: (gid: string, accountId: string, inviteLink: string) => call('POST', `/groups/${enc(gid)}/join`, { accountId, inviteLink }),
  promote: (gid: string, byAccountId: string, accountId: string) => call('POST', `/groups/${enc(gid)}/promote`, { byAccountId, accountId }),
  kick: (gid: string, byAccountId: string, targetPlatformUserId: string) =>
    call('POST', `/groups/${enc(gid)}/kick`, { byAccountId, targetPlatformUserId }, 8_000),
  leave: (gid: string, accountId: string) => call('POST', `/groups/${enc(gid)}/leave`, { accountId }),
  members: (gid: string) => call<{ platformUserId: string }[]>('GET', `/groups/${enc(gid)}/members`),
  send: (gid: string, accountId: string, clientMsgId: string, text: string) =>
    call('POST', `/groups/${enc(gid)}/send`, { accountId, clientMsgId, text }, 8_000),
  byClientId: (gid: string, clientMsgId: string) =>
    call<{ msgId: string; sentAt: string }>('GET', `/groups/${enc(gid)}/messages/by-client-id/${enc(clientMsgId)}`, undefined, 3_000),
};
const enc = encodeURIComponent;
