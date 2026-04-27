import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { ActivityProgressModal } from './ActivityProgressModal';
import type { SystemActivity, ActivityProgress } from '@sdk';

function phaseLabel(activity: SystemActivity): string {
  switch (activity) {
    case 'archive': return 'Archiving';
    case 'clear': return 'Clearing index';
    case 'load_from_archive': return 'Restoring';
    case 'scan': return 'Scanning';
    case 'index': return 'Indexing';
  }
}

function detailLabel(activity: SystemActivity, progress: ActivityProgress | null): string {
  if (!progress) return phaseLabel(activity);
  const typesDone = progress.jobDone ?? progress.done.length ?? 0;
  const typesTotal = progress.jobTotal ?? progress.total ?? 0;
  const typeSummary = typesTotal > 0 ? `${typesDone}/${typesTotal}` : '';
  if (progress.current && progress.recordsTotal != null && progress.recordsDone != null) {
    return `${phaseLabel(activity)} ${typeSummary} · ${progress.current} ${progress.recordsDone}/${progress.recordsTotal}`;
  }
  return typeSummary ? `${phaseLabel(activity)} ${typeSummary}` : phaseLabel(activity);
}

export function IndexingIndicator() {
  const { currentActivity, activityProgress } = useSystemTools();
  const [open, setOpen] = useState(false);

  if (!currentActivity) return null;

  return (
    <>
      <span className="mx-2 h-3 w-px bg-border/70 shrink-0" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Show index progress"
        data-testid="footer-indexing-indicator"
      >
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
        <span className="truncate max-w-[320px] tabular-nums">
          {detailLabel(currentActivity, activityProgress)}
        </span>
      </button>
      <ActivityProgressModal
        open={open}
        onOpenChange={setOpen}
        progress={activityProgress}
        title={phaseLabel(currentActivity)}
      />
    </>
  );
}
