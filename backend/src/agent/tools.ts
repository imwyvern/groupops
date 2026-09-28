import { Ajv } from 'ajv';

/** The four tools, exactly as sent to the Agent service. `required` covers every property (spec 2.2). */
export const TOOLS = [
  {
    name: 'get_recent_messages',
    description: 'Read the most recent messages of the current group, oldest first. Includes the trigger messages and anything that arrived during this run. At most 50.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, description: 'How many messages (max 50).' } }, required: ['limit'], additionalProperties: false },
  },
  {
    name: 'send_message',
    description: 'Send a text message to the group as one of the platform service accounts. Reusing an idempotency_key within this run returns the earlier message instead of sending again.',
    input_schema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, idempotency_key: { type: 'string', minLength: 1 } }, required: ['text', 'idempotency_key'], additionalProperties: false },
  },
  {
    name: 'kick_user',
    description: 'Remove a member from the group. Requires the group policy autoKickEnabled.',
    input_schema: { type: 'object', properties: { platform_user_id: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } }, required: ['platform_user_id', 'reason'], additionalProperties: false },
  },
  {
    name: 'finish',
    description: 'End this run with a short summary of what was done.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];
const ajv = new Ajv({ allErrors: true });
const validators = Object.fromEntries(TOOLS.map((t) => [t.name, ajv.compile(t.input_schema)]));

export const isKnownTool = (name: string): name is ToolName => name in validators;
export function validateInput(name: ToolName, input: unknown): string | null {
  const v = validators[name];
  return v(input) ? null : ajv.errorsText(v.errors);
}
