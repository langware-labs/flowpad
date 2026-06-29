import type { Conversation, ConversationParticipant } from '@sdk';
import { participantLabel } from './participant-display';

/**
 * Derive a display title for a Conversation. Used wherever we render a
 * conversation as a row or tab so the label stays consistent across the app.
 *
 * Order of preference:
 *   1. Entity's `title` (user-set in NewConversationDialog, shipped via bundle)
 *   2. Entity's own `name` (legacy / set by Community Assistance)
 *   3. Comma-joined participant names/emails
 *   4. "Conversation <short-id>" so each row stays visually distinguishable
 */
export function deriveConversationTitle(conv: Conversation | null | undefined): string {
  if (!conv) return 'Conversation';
  const title = conv.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  const name = (conv as { name?: string | null }).name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  const parts = (conv.participants ?? [])
    .map((p) => participantLabel(p));
  if (parts.length > 0) return parts.join(', ');
  if (conv.id) return `Conversation ${conv.id.slice(0, 8)}`;
  return 'Conversation';
}

/**
 * Slack-style autofill title for a *new* conversation:
 *   "<me>, <p1>, <p2> - <Mon D HH:MM>"
 * Empty participants degrades to "New conversation - <Mon D HH:MM>".
 *
 * The ``when`` Date is taken from the caller so the autofill stays stable
 * across re-renders within a session (the open-dialog memoises it).
 */
export function formatAutoTitle(
  participants: ConversationParticipant[],
  myLabel: string,
  when: Date,
): string {
  const day = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = when.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dateSuffix = `${day} ${time}`;
  if (participants.length === 0) return `New conversation - ${dateSuffix}`;
  const others = participants.map(participantLabel).join(', ');
  return `${myLabel}, ${others} - ${dateSuffix}`;
}
