// Types mirroring the backend REST / WS contract.

export type Role = 'admin' | 'viewer';

export type AccountStatus =
  | 'idle'
  | 'online'
  | 'rate_limited'
  | 'disconnected'
  | 'suspended'
  | 'session_expired';

export interface Account {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
}

export type GroupStatus = 'active' | 'unreachable' | 'left';
export type MemberRole = 'creator' | 'admin' | 'member';

export interface GroupMember {
  accountId: string;
  platformUserId: string | null;
  role: MemberRole;
}

export interface Group {
  id: string;
  gatewayGroupId: string | null;
  status: GroupStatus;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: GroupMember[];
  activeSequenceRunId: string | null;
  activeAgentRunId: string | null;
}

export type JobStatus = 'running' | 'finished' | 'failed';

export interface Job {
  status: JobStatus;
  errors: { step: string; code: string }[];
}

export type DeliveryStatus = 'queued' | 'accepted' | 'sent' | 'failed' | 'unknown' | 'cancelled';

export interface Message {
  id: string;
  msgId: string | null;
  clientMsgId: string | null;
  senderPlatformUserId: string | null;
  isOwn: boolean;
  text: string;
  sentAt: string | null;
  deliveryStatus: DeliveryStatus | null;
  failCode: string | null;
}

export interface MessagePage {
  items: Message[];
  nextCursor: string | null;
}

export type AgentRunStatus = 'running' | 'finished' | 'failed' | 'blocked' | 'cancelled';

export interface AgentRunSummary {
  id: string;
  groupId: string;
  status: AgentRunStatus;
  endReason: string | null;
  summary: string | null;
  createdAt: string;
}

export interface AgentStep {
  kind: 'tool_use' | 'final' | 'protocol_error';
  toolUseId: string | null;
  name: string | null;
  input: unknown;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  rawResponse: string | null;
}

export interface AgentRunDetail extends Omit<AgentRunSummary, 'createdAt'> {
  createdAt?: string;
  steps: AgentStep[];
}

export interface SequenceStepDef {
  index: number;
  accountRole: string;
  text: string;
  delaySeconds: number;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStepDef[];
}

/** `vars` are run-level defaults; `stepVars` override per step index. */
export type Vars = Record<string, string>;
export type StepVars = Record<string, Vars>;
export type VarSource = 'default' | `step:${number}`;

export interface PrecheckStep {
  index: number;
  text: string;
  resolvedText: string;
  resolvedVars: Vars;
  varSources: Record<string, VarSource>;
}

export type SequenceRunStatus = 'running' | 'finished' | 'failed' | 'stopped';
export type SequenceRunStepStatus = 'pending' | 'accepted' | 'sent' | 'skipped' | 'failed';

export interface SequenceRunStep {
  index: number;
  status: SequenceRunStepStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  clientMsgId: string | null;
  resolvedVars: Vars;
  varSources: Record<string, VarSource>;
}

export interface SequenceRun {
  id: string;
  groupId: string;
  sequenceId: string;
  status: SequenceRunStatus;
  currentStepIndex: number;
  steps: SequenceRunStep[];
}

export interface SequenceRunSummary {
  id: string;
  status: SequenceRunStatus;
  currentStepIndex: number;
  sequenceId: string;
  createdAt: string;
}

// ---- WebSocket event payloads, keyed by frame `type` ----

export interface WsEventMap {
  account_status_changed: { accountId: string; from: AccountStatus; to: AccountStatus };
  account_terminal: { accountId: string; status: AccountStatus };
  inconsistency: { kind: string; ref: string; message: string };
  message: { groupId: string; msgId: string; isOwn: boolean };
  message_status: { groupId: string; clientMsgId: string; deliveryStatus: DeliveryStatus };
  member_changed: { groupId: string };
  group_changed: { groupId: string };
  agent_run: { runId: string; groupId: string; status: AgentRunStatus; endReason: string | null };
  agent_step: { runId: string };
  sequence_run: { runId: string; groupId: string; status: SequenceRunStatus; currentStepIndex: number };
}

export type WsEventType = keyof WsEventMap;
