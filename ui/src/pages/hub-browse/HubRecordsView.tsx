import { PageId, QueryRequest, ViewType } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { MessageSquare } from 'lucide-react';
import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';

/**
 * HubRecordsView — a generic entity list for the hub page. Lists one OSS entity
 * type via the hub's `graph/<type>` **read** (access-scoped; the hub owns the
 * API/security), rendered with OSS UI primitives. No hub-specific ontology.
 *
 * Reuse-first (see [[oss-ontology-hub-api-division]]): rows open the existing OSS
 * viewer for that type under page=hub. Phase 2a wires the pure-graph types only
 * (Conversations); content-bearing types (docs/tasks) are deferred until the
 * OSS content model reads from entity fields.
 *
 * URL: /dock/hub/records/<type>
 */

// Minimal shape we read off any listed entity for a row.
type Row = { id?: string; title?: string | null; name?: string | null; updated_date?: string | null };

const TYPE_LABEL: Record<string, string> = {
  conversation: 'Conversations',
  task: 'Tasks',
  markdown: 'Docs',
  agentic_flow: 'Flows',
  knowledge_base: 'Knowledge bases',
  whiteboard: 'Whiteboards',
};

export function HubRecordsView({ type }: { type?: string }) {
  const { navigation } = useDockNavigation();

  const request = useMemo(
    () => (type ? new QueryRequest({ type, query: null, scope: [], name: `hub-records-${type}` }) : null),
    [type],
  );
  const { data: rows = [], isLoading } = useEntitiesQuery<Row>(request as QueryRequest, {
    enabled: !!type && !!request,
  });

  const open = (row: Row) => {
    if (!row.id || !type) return;
    // Conversations reuse the OSS ConversationRoute (pure-graph). Every other
    // type opens in the generic HubEntityView (title + entity-field content).
    if (type === 'conversation') {
      navigation.openPage(PageId.HUB, ViewType.CONVERSATION, row.id);
    } else {
      navigation.openPage(PageId.HUB, ViewType.HUB_ENTITY, `${type}/${row.id}`);
    }
  };

  const label = (type && TYPE_LABEL[type]) || type || 'Records';

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-8">
        <h1 className="text-xl font-semibold">{label}</h1>

        {isLoading ? (
          <p className="text-sm text-muted-foreground"><Trans>Loading…</Trans></p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground"><Trans>Nothing here yet.</Trans></p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => open(row)}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
              >
                <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {row.title || row.name || row.id}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default HubRecordsView;
