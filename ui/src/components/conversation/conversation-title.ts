import type { Conversation } from '@sdk';
import { participantLabel } from './participant-display';

/**
 * Derive a display title for a Conversation. Used wherever we render a
 * conversation as a row or tab so the label stays consistent across the app.
 *
 * Order of preference:
 *   1. Entity's own `name` (set explicitly, e.g. by Community Assistance)
 *   2. Comma-joined participant names/emails
 *   3. "Conversation <short-id>" so each row stays visually distinguishable
 */
export function deriveConversationTitle(conv: Conversation | null | undefined): string {
  if (!conv) return 'Conversation';
  const name = (conv as { name?: string | null }).name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  const parts = (conv.participants ?? [])
    .map((p) => participantLabel(p));
  if (parts.length > 0) return parts.join(', ');
  if (conv.id) return `Conversation ${conv.id.slice(0, 8)}`;
  return 'Conversation';
}
