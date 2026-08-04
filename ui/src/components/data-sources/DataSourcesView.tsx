/**
 * Data sources — the configured pullers, and a way to add one.
 *
 * Global by construction: `scope: []`, because a DataSource is a property of the
 * instance, not of a project (flow_sdk/builtin/data_source.py says so, and the
 * scheduler tick that polls it has no request context to resolve a scope from).
 * Switching project must not change what this shows, which is also why the view
 * is deliberately absent from SCOPE_SEEDED_VIEWS.
 *
 * Before this, sources rendered only inside the dev-only Signals pane and could
 * not be created from the UI at all.
 */
import { useCallback, useMemo, useState } from 'react';
import { DataSource, QueryRequest } from '@sdk';
import { Plus } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { DataSourceCard } from './DataSourceCard';
import { DataSourceDialog } from './DataSourceDialog';

const sourcesQuery = new QueryRequest({
  type: DataSource.type,
  scope: [],
  name: 'data-sources:list',
});

export function DataSourcesView() {
  const { data: sources = [], refetch } = useEntitiesQuery<DataSource>(sourcesQuery);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DataSource | null>(null);
  const Icon = iconForType(DataSource.type);

  const openAdd = useCallback(() => {
    setEditing(null);
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback((source: DataSource) => {
    setEditing(source);
    setDialogOpen(true);
  }, []);

  // A delete removes a row rather than changing one, and the live query watches
  // for writes — so this is the one mutation that needs an explicit re-read.
  const onDeleted = useCallback(() => void refetch(), [refetch]);

  const sorted = useMemo(
    () => [...sources].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [sources],
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <header className="mb-3 flex items-center gap-2">
        <Icon className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">
          <Trans>Data sources</Trans>
        </h1>
        <span className="text-sm text-muted-foreground">{sources.length}</span>
      </header>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        <Trans>
          One per remote feed or account. The poller syncs each on the heartbeat and turns what it
          finds into records you can search, read and build flows on.
        </Trans>
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* The add tile leads the grid and stays put when the grid is empty —
            this screen is where the first source is created. */}
        <button
          type="button"
          data-testid="add-data-source"
          onClick={openAdd}
          className="flex min-h-[7rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
        >
          <Plus className="size-5" />
          <Trans>Add data source</Trans>
        </button>

        {sorted.map((source) => (
          <DataSourceCard
            key={source.id}
            source={source}
            onEdit={openEdit}
            onDeleted={onDeleted}
          />
        ))}
      </div>

      {sources.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          <Trans>
            No data sources configured yet. Add one and it starts syncing within a minute.
          </Trans>
        </p>
      )}

      <DataSourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />
    </div>
  );
}

export default DataSourcesView;
