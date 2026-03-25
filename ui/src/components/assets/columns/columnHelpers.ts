import React from 'react';
import type { ReactNode } from 'react';

/**
 * Renders a filesystem path as just its last segment, with the full path in a tooltip.
 * If the path has no slashes (already a short name), shows it as-is.
 */
export function pathCell(path: string | undefined): ReactNode {
  if (!path) return '—';
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  const last = parts[parts.length - 1] || path;
  if (last === path) return React.createElement('span', null, path);
  return React.createElement(
    'span',
    { title: path, style: { cursor: 'default', textDecoration: 'underline dotted', textUnderlineOffset: '3px' } },
    last
  );
}

/**
 * Renders a scope value ("user" / "project") as a small styled badge.
 */
export function scopeTag(scope: string | undefined): ReactNode {
  if (!scope) return '—';
  const label = scope === 'user' ? 'user' : scope === 'project' ? 'project' : scope;
  const color = scope === 'user' ? '#7c3aed' : '#0369a1';
  return React.createElement(
    'span',
    {
      style: {
        fontSize: '11px',
        fontWeight: 500,
        padding: '1px 6px',
        borderRadius: '4px',
        border: `1px solid ${color}`,
        color,
        whiteSpace: 'nowrap',
      },
    },
    label
  );
}

/**
 * Truncates a string to maxLen characters with ellipsis, adding a tooltip for the full value.
 */
export function truncCell(text: string | undefined, maxLen = 60): ReactNode {
  if (!text) return '—';
  if (text.length <= maxLen) return React.createElement('span', null, text);
  return React.createElement(
    'span',
    { title: text, style: { cursor: 'default' } },
    text.slice(0, maxLen) + '…'
  );
}
