/**
 * Mock Agent service implementing spec §2.2 (Anthropic tool-use shaped turns).
 *
 * The script played for a run is chosen by, in priority order:
 *   1. a `[agent:<mode>]` tag in the first trigger message text, e.g. "[agent:bad] hi"
 *   2. the default mode set through POST /__control { mode }
 * The turn index is derived from the conversation itself (one appended user
 * message per step), so a backend restart that replays a turn gets the same answer.
 */
import { createRouter, send, sleep } from './http.js';

const TOOL_NAMES = ['get_recent_messages', 'send_message', 'kick_user', 'finish'];
let control = { mode: 'normal', auditMode: 'pass', turnDelayMs: 0 };
const calls = { turn: 0, audit: 0 };

type Block = { type: string; [k: string]: any };
type Msg = { role: 'user' | 'assistant'; content: Block[] };

const toolUse = (id: string, name: string, input: unknown) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const endTurn = (text: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

/** Each script maps (turn index, context) → response body (object = JSON, string = raw text). */
const scripts: Record<string, (turn: number, ctx: Ctx) => unknown> = {
  // read → reply → finish
  normal: (t, c) => [
    toolUse(`tu_${c.runId}_1`, 'get_recent_messages', { limit: 10 }),
    toolUse(`tu_${c.runId}_2`, 'send_message', { text: `收到：${c.lastText}`, idempotency_key: `k-${c.runId}` }),
    toolUse(`tu_${c.runId}_3`, 'finish', { summary: 'replied to the group' }),
  ][t] ?? endTurn('done'),
  // S5: same idempotency_key twice
  'retry-key': (t, c) => [
    toolUse(`tu_${c.runId}_1`, 'send_message', { text: `回复：${c.lastText}`, idempotency_key: 'k-same' }),
    toolUse(`tu_${c.runId}_2`, 'send_message', { text: `回复：${c.lastText}`, idempotency_key: 'k-same' }),
    toolUse(`tu_${c.runId}_3`, 'finish', { summary: 'sent once' }),
  ][t] ?? endTurn('done'),
  // S6: fenced JSON, unknown tool, then a normal ending
  bad: (t, c) => [
    '```json\n' + JSON.stringify(endTurn('oops')) + '\n```',
    toolUse(`tu_${c.runId}_2`, 'delete_group', { confirm: true }),
    endTurn('gave up politely'),
  ][t] ?? endTurn('done'),
  // garbage forever → protocol_errors
  garbage: () => 'I think the answer is {"stop_reason": ...',
  // repeated identical tool call → must end within 12 steps
  loop: (_t, c) => toolUse(`tu_${c.runId}_${Math.random().toString(36).slice(2)}`, 'get_recent_messages', { limit: 10 }),
  // duplicate tool_use id
  'dup-id': (t) => [toolUse('tu_dup', 'get_recent_messages', { limit: 5 }), toolUse('tu_dup', 'get_recent_messages', { limit: 5 }), toolUse('tu_last', 'finish', { summary: 'ok' })][t] ?? endTurn('done'),
  // kick the (external) sender of the trigger message
  kick: (t, c) => [
    toolUse(`tu_${c.runId}_1`, 'kick_user', { platform_user_id: c.lastSender, reason: 'spam' }),
    toolUse(`tu_${c.runId}_2`, 'finish', { summary: 'kicked' }),
  ][t] ?? endTurn('done'),
  // oversized limit + invalid input
  edge: (t, c) => [
    toolUse(`tu_${c.runId}_1`, 'get_recent_messages', { limit: 100000 }),
    toolUse(`tu_${c.runId}_2`, 'send_message', { text: 42 }),
    toolUse(`tu_${c.runId}_3`, 'finish', { summary: 'edge cases done' }),
  ][t] ?? endTurn('done'),
  slow: (t, c) => (t === 0 ? { __sleep: 20_000 } : toolUse(`tu_${c.runId}_${t}`, 'finish', { summary: 'after slow' })),
};

interface Ctx { runId: string; lastText: string; lastSender: string }

const r = createRouter();

r.post('/agent/turn', async (req, res) => {
  calls.turn++;
  const { runId, tools, messages } = req.body as { runId: string; tools: any[]; messages: Msg[] };
  const invalid = !Array.isArray(tools) || tools.length !== 4
    || TOOL_NAMES.some((n) => !tools.find((t) => t.name === n))
    || tools.some((t) => {
      const s = t.input_schema; const props = Object.keys(s?.properties ?? {});
      return s?.type !== 'object' || !Array.isArray(s.required) || props.some((p) => !s.required.includes(p));
    });
  if (invalid) return send(res, 400, { code: 'TOOLS_INVALID', message: 'tools must be exactly the 4 declared tools with full required lists' });

  const trigger = JSON.parse(messages[0].content[0].text);
  const last = trigger.triggerMessages.at(-1) ?? {};
  const tag = /\[agent:([\w-]+)\]/.exec(trigger.triggerMessages[0]?.text ?? '')?.[1];
  const script = scripts[tag ?? control.mode] ?? scripts.normal;
  const turn = messages.filter((m) => m.role === 'user').length - 1;
  const out = script(turn, { runId, lastText: last.text ?? '', lastSender: last.senderPlatformUserId ?? '' }) as any;

  if (control.turnDelayMs) await sleep(control.turnDelayMs);
  if (out && out.__sleep) { await sleep(out.__sleep); return send(res, 200, endTurn('late')); }
  if (typeof out === 'string') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(out); }
  send(res, 200, out);
});

r.post('/agent/audit', async (req, res) => {
  calls.audit++;
  const mode = control.auditMode;
  if (mode === '500') return send(res, 500, { message: 'audit down' });
  if (mode === 'garbage') { res.writeHead(200); return res.end('verdict: pass'); }
  if (mode === 'weird') return send(res, 200, { verdict: 'maybe' });
  if (mode === 'slow') { await sleep(30_000); return send(res, 200, { verdict: 'pass', reason: 'late' }); }
  const text: string = req.body.text ?? '';
  if (mode === 'fail' || text.includes('forbidden-word')) return send(res, 200, { verdict: 'fail', reason: 'policy' });
  send(res, 200, { verdict: 'pass', reason: 'ok' });
});

r.post('/__control', (req, res) => { control = { ...control, ...req.body }; send(res, 200, control); });
r.post('/__reset', (_req, res) => { control = { mode: 'normal', auditMode: 'pass', turnDelayMs: 0 }; calls.turn = calls.audit = 0; send(res, 200, control); });
r.get('/__state', (_req, res) => send(res, 200, { control, calls }));

const port = Number(process.env.PORT ?? 4002);
r.server.listen(port, () => console.log(`[mock-agent] listening on :${port}`));
