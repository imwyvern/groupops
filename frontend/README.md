# GroupOps frontend

React 18 + TypeScript + Vite + react-router v6. No UI library; all styles live in `src/styles.css`.

## Run

```bash
pnpm install
pnpm dev         # http://localhost:5173 — proxies /api and /ws to localhost:3000
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc --noEmit && vite build
```

The backend must be listening on `:3000`.

## Layout

| Path | What it holds |
| --- | --- |
| `src/api/client.ts` | Fetch wrapper `api()`: bearer header, `{ error: { code, message, requestId } }` → `ApiError`, 401 → refresh → retry once, login/logout |
| `src/api/tokenStore.ts` | Access token in memory (mirrored to sessionStorage) and the JWT payload decode |
| `src/api/endpoints.ts` | One typed function per REST endpoint |
| `src/api/types.ts` | Contract types, including the WS event payload map |
| `src/ws/WsClient.ts` | The single WebSocket connection: auth handshake, `lastSeq` dedupe/resume, backoff reconnect |
| `src/ws/WsProvider.tsx` | React glue: `useWsEvent(type, fn)`, `useResync(fn)`, `useConnectionState()` |
| `src/auth/AuthContext.tsx` | Session from the token store, `<AdminOnly>` gate |
| `src/domain/*` | Pure rules: legal account actions, message merge/sort, sequence input parsing |
| `src/pages/*` | One file per route |

## Auth and the single-flight refresh

- The access token is kept in memory and mirrored to `sessionStorage`, so reloading the tab keeps you logged in. The refresh token is an HttpOnly cookie that JS never reads. Every request uses `credentials: 'include'`.
- On first load with no token, the app tries one silent `POST /api/auth/refresh`, in case the cookie is still valid.
- **Single flight:** `refreshAccessToken()` stores the in-flight promise in a module variable. Every caller that hits a 401 while a refresh is running awaits that same promise. The variable is cleared in `finally`. So N concurrent 401s cause exactly one `/auth/refresh`.
- **Late 401s:** `api()` remembers which token it sent. If it gets a 401 but the stored token has changed since then (another caller already refreshed), it retries with the new token and does not refresh again.
- Each request is retried at most once. If the refresh fails, the token store is cleared. `RequireAuth` then sends the user to `/login`, and the WebSocket is closed.
- The WS client uses the same `refreshAccessToken()` when the server answers `{type:'auth', success:false}`.

## Realtime (B4)

- `WsClient` keeps `lastSeq`. It drops any frame whose `seq <= lastSeq`, and it sends `sinceSeq: lastSeq` in the auth frame when it reconnects.
- Reconnect backoff starts at 500 ms, doubles up to a 3 s cap, and resets after a successful auth.
- After every re-authentication except the first, `resync` listeners fire. Each page re-fetches the data on screen. This covers the case where the server can't replay the gap, e.g. after a restart.
- Pages refetch rather than patch state from event payloads. Messages are merged by row `id`, so refetching is idempotent and can't create duplicate rows. Bursts of message events are coalesced into at most one in-flight fetch plus one queued fetch.
- Toasts appear for `inconsistency`, `account_terminal` and `agent_run` with status `blocked`. The top bar shows the connection state.

## Roles

Write controls are only rendered for `admin`, via `<AdminOnly>` or `isAdmin`. That covers connect/transition, create group, the agent/auto-kick toggles, leave-all, send, start sequence and create sequence. The sequence-start route is also guarded by `RequireAdmin`. Viewers see the toggle values as plain text. The server still enforces permissions; the UI only hides the controls.

## Contract assumptions

- JWT payload: `{ sub, username, role, exp }`. `exp` is not used to refresh ahead of time; refresh happens on the next 401.
- Nullable fields (`platformUserId`, `gatewayGroupId`, `sentAt`, `deliveryStatus`, `failCode`, `endReason`, `summary`, `rawResponse`, step `name`/`errorCode`/`auditVerdict`) are shown as `—` when null.
- Messages with `sentAt: null` (still queued) sort to the bottom of the timeline.
- Agent run steps have no id of their own, so the React key is the position plus `toolUseId`. The `#` column is 1-based.
- The send box only appears when the group status is `active`, and leave-all is disabled when the status is `left`. These are UI choices; the server remains authoritative.
- A 422 `UNRESOLVED_PLACEHOLDER` carries `stepIndex` and `key` at the top level of `error`. `ApiError.extra` keeps every field beyond code/message/requestId.
- `stepVars` keys must be numeric step indices, and values must be string maps. This is checked on the client before sending.
- Placeholders use the spec's `{key}` syntax; the client never resolves them itself — previews come from `POST /api/sequences/:id/precheck`, so the preview is exactly what the server will send.
