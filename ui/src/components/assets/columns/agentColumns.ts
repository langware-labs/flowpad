import React from 'react';
import { registerColumns } from './columnRegistry';
import type { SearchResult } from '@src/hooks/use-asset-search';

function agentLocationCell(r: SearchResult): React.ReactNode {
  const path = r.source_path || '';
  const claudeIdx = path.indexOf('/.claude/agents/');
  if (claudeIdx <= 0) return '—';
  const prefix = path.slice(0, claudeIdx);
  const parts = prefix.split('/').filter(Boolean);
  const label = parts[parts.length - 1] || prefix;
  return React.createElement('span', { title: prefix }, label);
}

registerColumns('agent', [
  { key: 'location', header: 'Location', render: (r: SearchResult) => agentLocationCell(r) },
]);
