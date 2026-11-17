/**
 * `@name` in a conversation: finding the tag being typed, who can be tagged, what a pick writes into the text, and
 * which picks still stand when the message is sent. Pure text work -- the composer owns the state, the hub decides
 * who really counts (it keeps members who may read the conversation and tells them).
 */
import type { ConversationParticipant } from '@sdk/entities/conversation';

/** Someone chosen from the list: the hub user id the send carries, and the name written after the `@`. */
export interface MentionPick {
  id: string;
  name: string;
}

const MENU_LIMIT = 6;

/** The `@query` the caret is at the end of -- at the start of the text or after a space -- else null. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  return /\s/.test(query) ? null : { start: at, query };
}

function labelOf(p: ConversationParticipant): string {
  return (p.name ?? '').trim() || (p.email ?? '').trim();
}

/** Who the list offers for `query`: people with a hub user id (an invitation not yet accepted has none), not the
 *  viewer, whose name or email starts a word with it -- names starting with it first. */
export function mentionOptions(
  people: ConversationParticipant[] | null | undefined,
  viewerId: string | null,
  query: string,
): MentionPick[] {
  const q = query.trim().toLowerCase();
  const offered: { pick: MentionPick; rank: number }[] = [];
  const seen = new Set<string>();
  for (const p of people ?? []) {
    const id = p.user_id;
    const name = labelOf(p);
    if (!id || !name || id === viewerId || seen.has(id)) continue;
    const haystack = [name, p.email ?? ''].map((s) => s.toLowerCase());
    const rank =
      q === '' ? 0 : haystack.findIndex((s) => s.startsWith(q) || s.split(/\s+/).some((w) => w.startsWith(q)));
    if (rank < 0) continue;
    seen.add(id);
    offered.push({ pick: { id, name }, rank });
  }
  return offered
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MENU_LIMIT)
    .map((o) => o.pick);
}

/** The text with `@query` (from `start` to the caret) replaced by `@Name ` and where the caret goes. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}

function written(text: string, name: string): boolean {
  const at = text.indexOf(`@${name}`);
  if (at < 0) return false;
  const after = text[at + name.length + 1];
  return after === undefined || !/[\p{L}\p{N}_]/u.test(after);
}

/** The ids of the picks whose `@Name` is still in the text -- a name edited away or deleted is no longer a tag. */
export function mentionedIn(text: string, picks: MentionPick[]): string[] {
  return [...new Set(picks.filter((p) => written(text, p.name)).map((p) => p.id))];
}

/** The message text with each tagged person's `@Name` in bold, so it reads as a tag. `names` are the names of the
 *  people the message tags. */
export function highlightMentions(text: string, names: string[]): string {
  let out = text;
  for (const name of [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(^|\\s)@${escaped}(?![\\p{L}\\p{N}_])`, 'gu'),
      (_m, lead: string) => `${lead}**@${name}**`,
    );
  }
  return out;
}

/** The names the participants list gives the people a message tags (those it knows). */
export function namesOfMentioned(
  ids: string[] | null | undefined,
  people: ConversationParticipant[] | null | undefined,
): string[] {
  return (ids ?? []).map((id) => labelOf(people?.find((p) => p.user_id === id) ?? {})).filter(Boolean);
}
