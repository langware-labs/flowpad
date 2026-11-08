import { type User } from '@sdk';

import { EMAIL_RE } from '@src/components/contact-picker/use-contacts';

/** An entry as the Hub stores it: an address or `@domain`, or a contact's name resolved to their email. */
export function resolveEntry(raw: string, contacts: User[]): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('@')) return /^@[^\s@]+\.[^\s@]+$/.test(text) ? text.toLowerCase() : null;
  if (EMAIL_RE.test(text)) return text;
  const wanted = text.toLowerCase();
  const named = contacts.filter((u) => (u.name ?? '').trim().toLowerCase() === wanted && u.email);
  return named.length === 1 ? (named[0].email ?? null) : null;
}
