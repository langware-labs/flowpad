/**
 * Data sources — the configured pullers, and a way to add one.
 *
 * Global by construction: `scope: []`, because a DataSource is a property of the
 * instance, not of a project (flow_sdk/builtin/data_source.py says so, and the
 * scheduler tick that polls it has no request context to resolve a scope from).
 * Switching project must not change what this shows, which is also why the view
 * is deliberately absent from SCOPE_SEEDED_VIEWS.
 *
 * This owns both per-card dialogs — replay and delete are one instance each,
 * driven by the selected source, rather than 2N mounted with the grid. That
 * "list holds a nullable pending target, rows hold no dialog" shape is the
 * house pattern (connections-manager, chats-navigator, inbox-view, …).
 *
 * It deliberately does NOT query cursors. Watching that type live would put a
 * permanent subscription on the highest-churn rows on the instance — one write
 * per stream per poll — and repaint the whole grid every tick. The stream COUNT
 * rides on the source (`segment_count`, rolled up by the poller); the rows
 * themselves are fetched by a card only while it is expanded.
 *
 * Before this, sources rendered only inside the dev-only Signals pane and could
 * not be created from the UI at all.
 */
import { useCallback, useMemo, useState } from 'react';
import { DataSource, QueryRequest } from '@sdk';
import { Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { DataSourceCard } from './DataSourceCard';
import { useSourceSpecs } from './use-source-specs';
import { DataSourceDialog } from './DataSourceDialog';
import { ReplayDialog } from './ReplayDialog';

const sourcesQuery = new QueryRequest({
  type: DataSource.type,
  scope: [],
  name: 'data-sources:list',
});

export function DataSourcesView() {
  const { t } = useLingui();
  const { data: sources = [], refetch } = useEntitiesQuery<DataSource>(sourcesQuery);
  const { specFor } = useSourceSpecs();

  // A separate flag, not the `null = closed` idiom its two neighbours use:
  // `editing === null` is the legitimate "add new" state, so it cannot double
  // as closed.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DataSource | null>(null);
  const [replaying, setReplaying] = useState<DataSource | null>(null);
  const [deleting, setDeleting] = useState<DataSource | null>(null);
  const Icon = iconForType(DataSource.type);

  const openAdd = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((source: DataSource) => {
    setEditing(source);
    setEditorOpen(true);
  }, []);

  const confirmDelete = useCallback(
    async (source: DataSource) => {
      try {
        // `delete()`, not `destroy()` — the TS entity has no destroy, and the
        // backend cascade hangs off `delete_by_id`, which is what this reaches.
        await source.delete();
        // A delete removes a row rather than changing one, and the live query
        // watches for writes — so this is the one mutation needing a re-read.
        void refetch();
      } catch (error) {
        notify.error({
          title: t`Could not delete ${source.name || source.provider}`,
          message: errorMessage(error, t`The source was not removed.`),
        });
      }
    },
    [refetch, t],
  );

  const sorted = useMemo(
    () => [...sources].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [sources],
  );

  return (
    <div data-testid="data-sources-view" className="flex h-full flex-col overflow-y-auto p-6">
      <header className="mb-1 flex items-center gap-2">
        <Icon className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">
          <Trans>Data sources</Trans>
        </h1>
        {sources.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {sources.length}
          </span>
        )}
      </header>
      <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
        <Trans>
          One per remote feed or account. The poller syncs each on the heartbeat and turns what it
          finds into records you can search, read and build flows on.
        </Trans>
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map((source) => (
          <DataSourceCard
            key={source.id}
            source={source}
            setupWiki={specFor(source.provider)?.setup_wiki}
            iconName={specFor(source.provider)?.icon_name}
            onEdit={openEdit}
            onReplay={setReplaying}
            onDelete={setDeleting}
          />
        ))}

        {/* Trails the grid rather than leading it, so the eye starts on real
            sources — but it is still present when there are none, because this
            screen is where the first one is created. */}
        <button
          type="button"
          data-testid="add-data-source"
          onClick={openAdd}
          className="flex min-h-[8rem] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:bg-muted/30 hover:text-foreground"
        >
          <Plus className="size-5" />
          <Trans>Add data source</Trans>
        </button>
      </div>

      <DataSourceDialog open={editorOpen} onOpenChange={setEditorOpen} editing={editing} />

      <ReplayDialog
        source={replaying}
        open={!!replaying}
        onOpenChange={(next) => !next && setReplaying(null)}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        variant="destructive"
        title={t`Delete this data source?`}
        // Say what else goes: nothing cascades by default, so the backend's
        // delete override is the only reason these disappear together.
        description={t`"${deleting?.name || deleting?.provider || ''}" will be removed along with its streams and every record it ingested. This cannot be undone.`}
        confirmLabel={t`Delete`}
        onConfirm={() => deleting && void confirmDelete(deleting)}
      />
    </div>
  );
}

export default DataSourcesView;
