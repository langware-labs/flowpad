/**
 * The `diagnosis_request` browser surface — what the Assets body shows when the type root
 * itself is selected (`list/diagnosis_request`).
 *
 * Not `AssetListView`: that one searches the index and opens a row by its file, and a request
 * has no file — it lives on the hub. The rows are the type's `mine` action, the same list the
 * tree's type root shows, so a request that never reached the hub is not listed here either.
 */
import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';

import { DiagnosisRequest, TypeId } from '@sdk';
import { formatWhen, requestAction } from '@src/components/assets/editor/diagnosis-request/diagnosis-request-api';
import { type ListedRequest, requestsInScope } from '@src/components/browseable-tree/adapters/diagnosisRequestRoot';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useAction } from '@src/hooks/use-action';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';

export interface DiagnosisRequestsAssetListProps {
  scope: ScopeFilter;
  /** URL-first: the row click hands back the pointer to navigate to. */
  onOpen: (pointer: DockPointer) => void;
}

type Row = ListedRequest & { run_count?: number | null; last_run_at?: string | null };

export function DiagnosisRequestsAssetList({ scope, onOpen }: DiagnosisRequestsAssetListProps) {
  const action = useMemo(() => requestAction('mine'), []);
  const { data, isLoading } = useAction<Row[]>(action);
  const requests = requestsInScope(data ?? [], scope) as Row[];
  // Registry, not a literal — the same rule the tree adapter follows.
  const RequestIcon = iconForType(DiagnosisRequest.type);

  if (isLoading && !data) {
    return (
      <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="diagnosis-requests-asset-empty">
        <div className="max-w-sm space-y-2 text-center">
          <RequestIcon className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            <Trans>No diagnosis requests</Trans>
          </p>
        </div>
      </div>
    );
  }

  const open = (id: string) =>
    onOpen(DockPointer.forAssetEditorByTypeId(DiagnosisRequest.type, new TypeId(DiagnosisRequest.type, id)));

  return (
    <div className="h-full overflow-auto p-3" data-testid="diagnosis-requests-asset-list">
      <div className="space-y-2">
        {requests.map((request) => {
          const runs = request.run_count ?? 0;
          const last = formatWhen(request.last_run_at);
          return (
            <div
              key={request.id}
              role="button"
              tabIndex={0}
              className="flex w-full cursor-pointer flex-wrap items-center gap-2 rounded-md border p-3 text-start hover:bg-accent/50"
              data-testid={`diagnosis-request-row-${request.id}`}
              onClick={() => open(request.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  open(request.id);
                }
              }}
            >
              <RequestIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <span className="font-medium">{request.title || request.name || request.id}</span>
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground">
                <Trans>
                  {runs} runs · last {last}
                </Trans>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
