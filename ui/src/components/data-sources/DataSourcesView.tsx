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
import { DataSource } from '@sdk';
import { Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DataSourceCard } from './DataSourceCard';
import { useSourceDelete } from './use-source-delete';
import { sourcesQuery, useSourceSpecs } from './use-source-specs';
import { useStartVibeSession } from '@src/pages/flow-page/use-start-vibe-session';
import { Sparkles } from 'lucide-react';
import { DataSourceDialog } from './DataSourceDialog';
import { DesktopTile, TILE_TIP_DELAY } from '@src/components/quick-create/QuickCreatePanel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { ReplayDialog } from './ReplayDialog';

export function DataSourcesView() {
  const { t } = useLingui();
  const startVibe = useStartVibeSession();
  const { data: sources = [], refetch } = useEntitiesQuery<DataSource>(sourcesQuery);
  const { specFor } = useSourceSpecs();

  // A separate flag, not the `null = closed` idiom its two neighbours use:
  // `editing === null` is the legitimate "add new" state, so it cannot double
  // as closed.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DataSource | null>(null);
  const [replaying, setReplaying] = useState<DataSource | null>(null);
  const Icon = iconForType(DataSource.type);

  const openAdd = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((source: DataSource) => {
    setEditing(source);
    setEditorOpen(true);
  }, []);

  // A delete removes a row rather than changing one, and the live query
  // watches for writes — so this is the one mutation needing a re-read.
  const { deleting, setDeleting, remove, confirm } = useSourceDelete(() => void refetch());

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
      {sources.length === 0 && (
        // The from-scratch entry: the data-integrations persona connects a source,
        // shows a sample and agrees the output shape — the whole loop in one chat.
        <button
          type="button"
          data-testid="data-sources-ask-agent"
          onClick={() => startVibe(t`Connect a data source for me and help me define what I want out of each item.`)}
          className="mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
        >
          <Sparkles className="size-4" />
          <Trans>Ask the agent to connect one</Trans>
        </button>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map((source) => (
          <DataSourceCard
            key={source.id}
            source={source}
            spec={specFor(source.provider)}
            onEdit={openEdit}
            onReplay={setReplaying}
            onDelete={setDeleting}
          />
        ))}

        {/* Trails the grid rather than leading it, so the eye starts on real
            sources — but it is still present when there are none, because this
            screen is where the first one is created.

            The desktop's own "New" tile, not a card-sized dashed panel: adding a
            source is the same ACT as every other "new thing" in the app, and it
            was the one place that said so in a different shape. The cell keeps
            the grid's rhythm; the tile inside it keeps the desktop's. */}
        <div className="flex min-h-[8rem] items-center justify-center">
          <Tooltip delayDuration={TILE_TIP_DELAY}>
            <TooltipTrigger asChild>
              <DesktopTile
                data-testid="add-data-source"
                Icon={Plus}
                label={t`New`}
                onClick={openAdd}
                className="border-dashed"
              />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <Trans>Add a data source</Trans>
            </TooltipContent>
          </Tooltip>
        </div>
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
        {...confirm}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  );
}

export default DataSourcesView;
