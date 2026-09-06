import React from 'react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { endpointAssetPointer, fetchMyEndpoints } from '@src/components/llm-endpoints/my-endpoints';
import type { Browseable } from '@src/components/browseable-tree/types';

/**
 * Children of the `llm_endpoint` type root — the budgets this person may spend.
 *
 * Row-only, like `tag`: there is no local record and nothing in the search index, so the
 * generic `fetchAssetsOfType` (a `/search` call) would always answer zero. The rows come
 * from the box's own funding read instead, already narrowed to this person's own
 * endpoints — see `my-endpoints.ts` for why an org's or a team's pool is not one of them.
 *
 * Clicking a row opens the read-only asset page, NOT the hub's administration screen.
 */

/** The type's glyph, from the backend registry — never a literal (CLAUDE.md's icon law). */
const EndpointIcon = () => {
  const Icon = iconForType('llm_endpoint');
  return <Icon className="h-3.5 w-3.5 flex-shrink-0" />;
};

export async function llmEndpointListChildren(): Promise<Browseable[]> {
  const endpoints = await fetchMyEndpoints();
  return endpoints.map((endpoint) => ({
    id: `llm-endpoint:${endpoint.id}`,
    kind: 'asset',
    label: endpoint.name || endpoint.id,
    icon: <EndpointIcon />,
    // A disabled budget is still yours to look at; it just cannot be spent.
    rowClassName: endpoint.enabled ? undefined : 'opacity-50 hover:opacity-100',
    tooltip: endpoint.provider || undefined,
    hasChildren: false,
    pointer: endpointAssetPointer(endpoint.id),
  }));
}
