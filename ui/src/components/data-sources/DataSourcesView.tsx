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
import { DataSourceRow, ROW_GRID } from './DataSourceRow';
import { useSourceDelete } from './use-source-delete';
import { sourcesQuery, useSourceSpecs } from './use-source-specs';
import { useStartVibeSession } from '@src/pages/flow-page/use-start-vibe-session';
import { Sparkles } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { DataSourceDialog } from './DataSourceDialog';
import { Button } from '@src/components/ui/button';
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

  // Newest first: the source you just added is the one you came to look at.
  const sorted = useMemo(
    () =>
      [...sources].sort(
        (a, b) =>
          (b.created_date ? new Date(b.created_date).getTime() : 0) - (a.created_date ? new Date(a.created_date).getTime() : 0) ||
          (a.name || '').localeCompare(b.name || ''),
      ),
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
        {/* The primary act of this screen, where every list screen keeps it:
            top right, before any row — not trailing the grid as a tile. */}
        <Button className="ms-auto gap-1.5" onClick={openAdd} data-testid="add-data-source">
          <Plus className="size-4" />
          <Trans>New source</Trans>
        </Button>
      </header>
      <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
        <Trans>
          One per remote feed or account. The poller syncs each on the heartbeat and turns what it
          finds into records you can search, read and build flows on.
        </Trans>
      </p>

      {sources.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            <Trans>No sources yet. Connect a feed, a mailbox or a channel and the poller takes it from there.</Trans>
          </p>
          <div className="flex items-center gap-2">
            <Button className="gap-1.5" onClick={openAdd}>
              <Plus className="size-4" />
              <Trans>New source</Trans>
            </Button>
            {/* The from-scratch entry: the data-integrations persona connects a source,
                shows a sample and agrees the output shape — the whole loop in one chat. */}
            <Button
              variant="outline"
              className="gap-1.5"
              data-testid="data-sources-ask-agent"
              onClick={() => startVibe(t`Connect a data source for me and help me define what I want out of each item.`)}
            >
              <Sparkles className="size-4" />
              <Trans>Ask the agent to connect one</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className={cn(ROW_GRID, 'border-b border-border bg-muted/30 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground')}>
            <span><Trans>Source</Trans></span>
            <span><Trans>Status</Trans></span>
            <span><Trans>Streams</Trans></span>
            <span><Trans>Synced</Trans></span>
            <span><Trans>Next poll</Trans></span>
            <span className="text-end"><Trans>Actions</Trans></span>
          </div>
          {sorted.map((source) => (
            <DataSourceRow
              key={source.id}
              source={source}
              spec={specFor(source.provider)}
              onEdit={openEdit}
              onReplay={setReplaying}
              onDelete={setDeleting}
            />
          ))}
        </div>
      )}

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
