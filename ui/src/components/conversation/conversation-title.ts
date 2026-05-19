import type { Conversation } from '@sdk';
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
