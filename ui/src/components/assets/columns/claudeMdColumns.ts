import React from 'react';
import { registerColumns } from './columnRegistry';
import type { ColumnActions } from './columnRegistry';
import type { SearchResult } from '@src/hooks/use-asset-search';
import { scopeTag } from './columnHelpers';

function claudeMdProjectCell(r: SearchResult, actions?: ColumnActions): React.ReactNode {
  const sourcePath = r.file_path || r.asset_ref;
  if (!sourcePath) return '—';
  const parts = sourcePath.replace(/\/$/, '').split('/').filter(Boolean);
  parts.pop(); // remove filename
  const projectName = parts.pop();
  if (!projectName) return '—';
  const projectDir = '/' + parts.concat(projectName).join('/');

  if (actions?.filterByProject) {
    return React.createElement(
      'button',
      {
        title: projectDir,
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); actions.filterByProject!(projectName); },
        className: 'underline decoration-dotted underline-offset-2 cursor-pointer hover:text-foreground text-left',
      },
      projectName,
    );
  }
  return React.createElement('span', { title: projectDir }, projectName);
}

registerColumns('claude_md', [
  { key: 'scope', header: 'Scope', render: (r) => scopeTag(r.scope) },
  { key: 'project', header: 'Project', render: (r, actions) => claudeMdProjectCell(r, actions) },
]);
