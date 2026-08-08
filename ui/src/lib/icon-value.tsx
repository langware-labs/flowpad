import React, { type ReactNode } from 'react';
import * as lucideIcons from 'lucide-react';
import { isIconPath } from '@sdk';
import { lucideByName } from './lucide-by-name';

/**
 * Single renderer for stored entity icon values (Group/Prompt `icon` fields).
 *
 * The IconPicker stores either kind in one string field:
 *  - a lucide export name (e.g. "Search", "BookMarked") — the existing
 *    `lucideByName` convention,
 *  - a path to a file the backend serves (e.g. "icons/agent.svg"), or
 *  - an emoji character (e.g. "🚀").
 *
 * `isLucideName` discriminates by checking the actual lucide export table —
 * never by guessing — and `isIconPath` by the one character a lucide export
 * name can never contain, so an emoji (or any unknown string) renders as text.
 */

export function isLucideName(value: string | null | undefined): boolean {
  if (!value || !/^[A-Za-z][A-Za-z0-9]*$/.test(value)) return false;
  return value in (lucideIcons as unknown as Record<string, unknown>);
}

export function renderIconValue(
  value: string | null | undefined,
  opts: { className?: string; color?: string | null } = {},
): ReactNode {
  const { className = 'h-4 w-4', color } = opts;
  if (!value) return null;
  // A file-shaped value goes through the same seam; without that test it would
  // fall to the emoji branch and render as literal path text. `color` reaches a
  // lucide glyph and is ignored by an image, which carries its own.
  if (isLucideName(value) || isIconPath(value)) {
    const Icon = lucideByName(value);
    return <Icon className={className} style={color ? { color } : undefined} />;
  }
  return (
    <span className={`inline-flex items-center justify-center leading-none ${className}`} aria-hidden>
      {value}
    </span>
  );
}
