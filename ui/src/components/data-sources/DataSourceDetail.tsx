import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import type { DataSource } from '@sdk';
import { cn } from '@src/lib/utils';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DataSourceDialog } from './DataSourceDialog';
import { DataSourceRow, ROW_GRID } from './DataSourceRow';
import { ReplayDialog } from './ReplayDialog';
import { useSourceDelete } from './use-source-delete';
import { useSourceSpecs } from './use-source-specs';

/**
 * One data source, on its own — the Data Sources screen's row (status, sync, pull, edit, replay,
 * delete) and its dialogs, for a view that shows a single source (a source nested in the agent
 * editor). Same components as the list, so a source reads and acts the same wherever it is shown.
 */
export function DataSourceDetail({ source, onDeleted }: { source: DataSource; onDeleted?: () => void }) {
  const { specFor } = useSourceSpecs();
  const [editing, setEditing] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const { deleting, setDeleting, remove, confirm } = useSourceDelete(() => onDeleted?.());

  return (
    <div className="flex flex-col gap-3 p-6" data-testid="data-source-detail">
      <h2 className="text-lg font-semibold">{source.name || source.provider}</h2>
      <div className="overflow-hidden rounded-lg border border-border">
        <div
          className={cn(
            ROW_GRID,
            'border-b border-border bg-muted/30 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground',
          )}
        >
          <span>
            <Trans>Source</Trans>
          </span>
          <span>
            <Trans>Status</Trans>
          </span>
          <span>
            <Trans>Synced</Trans>
          </span>
          <span>
            <Trans>Next poll</Trans>
          </span>
          <span className="text-end">
            <Trans>Actions</Trans>
          </span>
        </div>
        <DataSourceRow
          source={source}
          spec={specFor(source.provider)}
          onEdit={() => setEditing(true)}
          onReplay={() => setReplaying(true)}
          onDelete={setDeleting}
        />
      </div>
      <DataSourceDialog open={editing} onOpenChange={setEditing} editing={source} />
      <ReplayDialog source={replaying ? source : null} open={replaying} onOpenChange={setReplaying} />
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
