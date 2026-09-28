import type { Message } from '../api/types';

/**
 * Merge message pages by stable row `id` (incoming wins, so status updates
 * replace stale copies) and return them oldest → newest for display.
 * Messages without `sentAt` (still queued) sort to the bottom.
 */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return Array.from(byId.values()).sort(compareChronological);
}

function compareChronological(a: Message, b: Message): number {
  if (a.sentAt !== b.sentAt) {
    if (a.sentAt === null) return 1;
    if (b.sentAt === null) return -1;
    const diff = Date.parse(a.sentAt) - Date.parse(b.sentAt);
    if (diff !== 0) return diff;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
