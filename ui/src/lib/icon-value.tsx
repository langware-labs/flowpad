import React, { type ReactNode } from 'react';
import * as lucideIcons from 'lucide-react';
import { lucideByName } from './lucide-by-name';

/**
 * Single renderer for stored entity icon values (Group/Prompt `icon` fields).
 *
 * The IconPicker stores either kind in one string field:
 *  - a lucide export name (e.g. "Search", "BookMarked") — the existing
 *    `lucideByName` convention, or
 *  - an emoji character (e.g. "🚀").
 *
 * `isLucideName` discriminates by checking the actual lucide export table —
 * never by guessing — so an emoji (or any unknown string) renders as text.
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
  if (isLucideName(value)) {
    const Icon = lucideByName(value);
    return <Icon className={className} style={color ? { color } : undefined} />;
  }
  return (
    <span className={`inline-flex items-center justify-center leading-none ${className}`} aria-hidden>
      {value}
    </span>
  );
}
