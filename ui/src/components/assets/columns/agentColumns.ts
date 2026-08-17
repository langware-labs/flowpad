import React from 'react';
import { registerColumns } from './columnRegistry';
import type { SearchResult } from '@src/hooks/use-asset-search';

function subAgentLocationCell(r: SearchResult): React.ReactNode {
  const path = r.asset_ref || '';
  const claudeIdx = path.indexOf('/.claude/agents/');
  if (claudeIdx <= 0) return '—';
  const prefix = path.slice(0, claudeIdx);
  const parts = prefix.split('/').filter(Boolean);
  const label = parts[parts.length - 1] || prefix;
  return React.createElement('span', { title: prefix }, label);
}

// Keyed on `subagent`: this cell reads `/.claude/agents/`, the provider-owned
// path a SubAgent lives at. The launchable `agent` type is a different asset
// (agentic-assets/agent/<name>/agent.md) and gets its own columns below.
registerColumns('subagent', [
  { key: 'location', header: 'Location', render: (r: SearchResult) => subAgentLocationCell(r) },
]);

registerColumns('agent', [
  { key: 'model', header: 'Model', render: (r: SearchResult) => (r as { model?: string }).model || '—' },
  {
    key: 'worker_type',
    header: 'Worker',
    render: (r: SearchResult) => (r as { worker_type?: string }).worker_type || '—',
  },
]);
