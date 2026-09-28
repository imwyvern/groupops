-- 001: core schema. Every invariant that must survive a restart lives here,
-- enforced by constraints/indexes rather than by in-memory state.

CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'viewer'))
);

-- One row per login session. A refresh-token reuse revokes the whole session,
-- which invalidates every access token carrying its sid.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY,
  user_id         int NOT NULL REFERENCES users(id),
  current_refresh text NOT NULL,           -- sha256 of the only valid refresh token
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE used_refresh_tokens (         -- rotated-out tokens, to detect reuse
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id)
);
CREATE TABLE revoked_access_tokens (jti uuid PRIMARY KEY, expires_at timestamptz NOT NULL);

CREATE TABLE accounts (
  id                  text PRIMARY KEY,
  status              text NOT NULL DEFAULT 'idle'
                      CHECK (status IN ('idle','online','rate_limited','disconnected','suspended','session_expired')),
  platform_user_id    text UNIQUE,
  rate_limited_until  timestamptz,
  version             int NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id                 uuid PRIMARY KEY,
  gateway_group_id   text UNIQUE,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unreachable','left')),
  creator_account_id text NOT NULL REFERENCES accounts(id),
  agent_enabled      boolean NOT NULL DEFAULT false,
  auto_kick_enabled  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Service-account membership as seen by us. Rows appear only on facts:
-- creator after group creation, others on member_joined.
CREATE TABLE group_members (
  group_id         uuid NOT NULL REFERENCES groups(id),
  account_id       text NOT NULL REFERENCES accounts(id),
  platform_user_id text NOT NULL,
  role             text NOT NULL CHECK (role IN ('creator','admin','member')),
  PRIMARY KEY (group_id, account_id)
);

CREATE TABLE jobs (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL,                 -- create_group | leave_all
  group_id   uuid REFERENCES groups(id),
  status     text NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed')),
  state      jsonb NOT NULL DEFAULT '{}',   -- resumable progress
  errors     jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Timeline: inbound and outbound messages share one table; an outbound row is
-- created (queued) BEFORE the gateway is called — that is the outbox.
CREATE TABLE messages (
  id                     bigserial PRIMARY KEY,
  group_id               uuid NOT NULL REFERENCES groups(id),
  msg_id                 text,
  client_msg_id          text UNIQUE,
  sender_platform_user_id text,
  account_id             text REFERENCES accounts(id),
  is_own                 boolean NOT NULL DEFAULT false,
  text                   text NOT NULL,
  sent_at                timestamptz NOT NULL,
  delivery_status        text CHECK (delivery_status IN ('queued','accepted','sent','failed','unknown','cancelled')),
  fail_code              text,
  -- outbox bookkeeping
  attempt_started_at     timestamptz,   -- set right before calling gateway send; non-null + queued = outcome unknown
  unknown_since          timestamptz,
  resend_count           int NOT NULL DEFAULT 0,
  next_attempt_at        timestamptz,
  source                 text,          -- operator | agent | sequence
  media_url              text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (delivery_status NOT IN ('failed','cancelled') OR fail_code IS NOT NULL)
);
CREATE UNIQUE INDEX messages_group_msg ON messages (group_id, msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX messages_timeline ON messages (group_id, sent_at DESC, id DESC);
CREATE INDEX messages_outbox ON messages (account_id, id) WHERE delivery_status IN ('queued','unknown');

-- Gateway event stream bookkeeping.
CREATE TABLE gateway_cursor (id int PRIMARY KEY CHECK (id = 1), safe_event_id bigint NOT NULL DEFAULT 0);
INSERT INTO gateway_cursor VALUES (1, 0);
CREATE TABLE processed_events (event_id bigint PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());

-- Push log for the WebSocket: rows are written in the same transaction as the
-- state they describe, then fanned out after commit (and replayable via sinceSeq).
CREATE TABLE ws_events (
  seq        bigserial PRIMARY KEY,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Agent runs.
CREATE TABLE agent_runs (
  id                  uuid PRIMARY KEY,
  group_id            uuid NOT NULL REFERENCES groups(id),
  status              text NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed','blocked','cancelled')),
  end_reason          text,
  summary             text,
  trigger_messages    jsonb NOT NULL,
  history             jsonb NOT NULL,            -- the `messages` array sent to /agent/turn
  step_count          int NOT NULL DEFAULT 0,
  protocol_error_streak int NOT NULL DEFAULT 0,
  elapsed_ms          bigint NOT NULL DEFAULT 0, -- wall-clock budget consumed before active_since
  active_since        timestamptz NOT NULL DEFAULT now(),
  lease_owner         text,
  lease_until         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
-- At most one running run per group, across any number of instances.
CREATE UNIQUE INDEX agent_runs_one_running ON agent_runs (group_id) WHERE status = 'running';

CREATE TABLE agent_steps (
  run_id          uuid NOT NULL REFERENCES agent_runs(id),
  idx             int NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('tool_use','final','protocol_error')),
  phase           text NOT NULL DEFAULT 'done' CHECK (phase IN ('executing','done')),
  tool_use_id     text,
  name            text,
  input           jsonb,
  result_summary  text,
  result_content  text,
  is_error        boolean NOT NULL DEFAULT false,
  error_code      text,
  audit_verdict   text,
  audit_attempts  int NOT NULL DEFAULT 0,
  effect          jsonb,          -- durable record of an external side effect in progress
  raw_response    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, idx)
);

-- Messages that arrived while a run was active; consumed by the next run.
CREATE TABLE agent_pending (
  group_id uuid NOT NULL REFERENCES groups(id),
  msg_id   text NOT NULL,
  PRIMARY KEY (group_id, msg_id)
);

CREATE TABLE agent_idempotency (
  run_id          uuid NOT NULL REFERENCES agent_runs(id),
  idempotency_key text NOT NULL,
  client_msg_id   text NOT NULL,
  PRIMARY KEY (run_id, idempotency_key)
);

-- Sequences.
CREATE TABLE sequences (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  steps      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sequence_runs (
  id                 uuid PRIMARY KEY,
  group_id           uuid NOT NULL REFERENCES groups(id),
  sequence_id        uuid NOT NULL REFERENCES sequences(id),
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed','stopped')),
  current_step_index int NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sequence_runs_one_running ON sequence_runs (group_id) WHERE status = 'running';
CREATE TABLE sequence_run_steps (
  run_id         uuid NOT NULL REFERENCES sequence_runs(id),
  idx            int NOT NULL,
  account_role   text NOT NULL,
  text           text NOT NULL,           -- already resolved
  delay_seconds  int NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','sent','skipped','failed')),
  scheduled_at   timestamptz,
  sent_at        timestamptz,
  client_msg_id  text,
  resolved_vars  jsonb NOT NULL,
  var_sources    jsonb NOT NULL,
  PRIMARY KEY (run_id, idx)
);
