import React, { useMemo } from 'react';

import { DiagnosisRequest, TypeId } from '@sdk';
import {
  callRequestAction,
  requestAction,
} from '@src/components/assets/editor/diagnosis-request/diagnosis-request-api';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import type { Browseable } from '@src/components/browseable-tree/types';
import { useAction } from '@src/hooks/use-action';
import { isAllScope, scopeIncludesUser, scopeProjectIds, type ScopeFilter } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';

/**
 * Children of the `diagnosis_request` type root — the requests this person may read.
 *
 * A request has no file for the indexer to read, so it is not a default-indexed type and the
 * generic `fetchAssetsOfType` (a `/search` call) would not list it. Like `llm_endpoint`, the rows
 * come from the hub instead (the type's `mine` action), which owns the runs and their tally.
 */

/** One row as `mine` lists it. `project_id` is this computer's copy's; null for a request opened elsewhere. */
export interface ListedRequest {
  id: string;
  title?: string | null;
  name?: string | null;
  project_id?: string | null;
}

/** The requests a scope shows: a project's own under that project, the rest under the user. */
export function requestsInScope(requests: ListedRequest[], scope: ScopeFilter): ListedRequest[] {
  if (isAllScope(scope)) return requests;
  const projects = new Set(scopeProjectIds(scope));
  const user = scopeIncludesUser(scope);
  return requests.filter((r) => (r.project_id ? projects.has(r.project_id) : user));
}

/** The listed requests (one shared fetch) — the type row's count reads it, as `llm_endpoint`'s does. */
export function useMyDiagnosisRequests(): ListedRequest[] {
  const action = useMemo(() => requestAction('mine'), []);
  const { data } = useAction<ListedRequest[]>(action);
  return data ?? [];
}

/** The type's glyph, from the backend registry — never a literal (CLAUDE.md's icon law). */
const RequestIcon = () => {
  const Icon = iconForType(DiagnosisRequest.type);
  return <Icon className="h-3.5 w-3.5 flex-shrink-0" />;
};

export async function diagnosisRequestListChildren(scope: ScopeFilter): Promise<Browseable[]> {
  const requests = requestsInScope((await callRequestAction<ListedRequest[]>('mine')) ?? [], scope);
  return requests.map((request) => ({
    id: `diagnosis-request:${request.id}`,
    kind: 'asset',
    label: request.title || request.name || request.id,
    icon: <RequestIcon />,
    hasChildren: false,
    pointer: DockPointer.forAssetEditorByTypeId(DiagnosisRequest.type, new TypeId(DiagnosisRequest.type, request.id)),
    // The same key a typeid-addressed URL selects by, so the open request's row highlights.
    selectionKey: `${DiagnosisRequest.type}-${request.id}`,
  }));
}
