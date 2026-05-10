import React from 'react';
import { registerColumns } from './columnRegistry';
import type { ColumnActions } from './columnRegistry';
import type { SearchResult } from '@src/hooks/use-asset-search';

function memoryProjectCell(r: SearchResult, actions?: ColumnActions): React.ReactNode {
  // Prefer the backend-resolved project_name; fall back to deriving a label
  // from the encoded directory in asset_ref for legacy/unindexed rows.
  let label = r.project_name || '';
  if (!label) {
    const path = r.asset_ref || '';
    const parts = path.replace(/\/$/, '').split('/');
    const memIdx = parts.lastIndexOf('memory');
    const encoded = memIdx > 0 ? parts[memIdx - 1] : '';
    if (!encoded) return '—';
    const stripped = encoded.replace(/^-/, '');
    const tokens = stripped.split('-').filter(Boolean);
    label = tokens.slice(-2).join('-') || stripped;
  }
  if (!label) return '—';

  if (actions?.filterByProject) {
    return React.createElement(
      'button',
      {
        title: label,
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); actions.filterByProject!(label); },
        className: 'underline decoration-dotted underline-offset-2 cursor-pointer hover:text-foreground text-left',
      },
      label,
    );
  }
  return React.createElement('span', null, label);
}

registerColumns('claude_memory', [
  { key: 'project', header: 'Project', render: (r, actions) => memoryProjectCell(r, actions) },
]);
