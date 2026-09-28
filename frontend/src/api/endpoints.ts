// Typed wrappers for every REST endpoint the UI uses.

import { api } from './client';
import type {
  Account,
  AccountStatus,
  AgentRunDetail,
  AgentRunSummary,
  Group,
  Job,
  MessagePage,
  PrecheckStep,
  Sequence,
  SequenceRun,
  SequenceRunSummary,
  SequenceStepDef,
  StepVars,
  Vars,
} from './types';

const enc = encodeURIComponent;

export const accountsApi = {
  list: () => api<Account[]>('GET', '/accounts'),
  connect: (id: string) => api<{ status: AccountStatus; platformUserId: string | null }>('POST', `/accounts/${enc(id)}/connect`),
  transition: (id: string, to: AccountStatus, expectedFrom: AccountStatus) =>
    api<{ status: AccountStatus }>('POST', `/accounts/${enc(id)}/transition`, { to, expectedFrom }),
};

export const groupsApi = {
  list: () => api<Group[]>('GET', '/groups'),
  get: (id: string) => api<Group>('GET', `/groups/${enc(id)}`),
  create: (creatorAccountId: string, memberAccountIds: string[]) =>
    api<{ jobId: string }>('POST', '/groups', { creatorAccountId, memberAccountIds }),
  patch: (id: string, patch: { agentEnabled?: boolean; autoKickEnabled?: boolean }) =>
    api<unknown>('PATCH', `/groups/${enc(id)}`, patch),
  send: (id: string, accountId: string, text: string) =>
    api<{ clientMsgId: string }>('POST', `/groups/${enc(id)}/send`, { accountId, text }),
  leaveAll: (id: string) => api<{ jobId: string }>('POST', `/groups/${enc(id)}/leave-all`),
  messages: (id: string, before?: string | null, limit = 50) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set('before', before);
    return api<MessagePage>('GET', `/groups/${enc(id)}/messages?${qs}`);
  },
  agentRuns: (id: string) => api<AgentRunSummary[]>('GET', `/groups/${enc(id)}/agent-runs`),
  sequenceRuns: (id: string) => api<SequenceRunSummary[]>('GET', `/groups/${enc(id)}/sequence-runs`),
  startSequenceRun: (id: string, sequenceId: string, vars: Vars, stepVars: StepVars) =>
    api<{ runId: string }>('POST', `/groups/${enc(id)}/sequence-runs`, { sequenceId, vars, stepVars }),
};

export const jobsApi = {
  get: (jobId: string) => api<Job>('GET', `/jobs/${enc(jobId)}`),
};

export const agentRunsApi = {
  get: (id: string) => api<AgentRunDetail>('GET', `/agent-runs/${enc(id)}`),
};

export const sequencesApi = {
  list: () => api<Sequence[]>('GET', '/sequences'),
  create: (name: string, steps: SequenceStepDef[]) => api<{ id: string }>('POST', '/sequences', { name, steps }),
  precheck: (id: string, vars: Vars, stepVars: StepVars) =>
    api<{ steps: PrecheckStep[] }>('POST', `/sequences/${enc(id)}/precheck`, { vars, stepVars }),
  getRun: (runId: string) => api<SequenceRun>('GET', `/sequence-runs/${enc(runId)}`),
};
