import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { TypeId } from '@sdk';
import { VibeAssignTaskDialog } from './VibeAssignTaskDialog';
import { workspaceToolbarButton } from './workspace-toolbar-button';

/**
 * "Hand this to someone" — the vibe workspace's assign affordance, next to
 * Collaborate. Collaborate opens a conversation; this creates a TASK and
 * assigns it, so the work lands on the other person's board rather than in a
 * thread.
 */
export function VibeAssignTaskButton({
  projectId,
  sessionTypeId,
}: {
  projectId: string | null;
  /** Active vibe session — supplies the optional transcript. */
  sessionTypeId: TypeId | null;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t`Ask someone for help`}
        className={workspaceToolbarButton}
        data-testid="vibe-assign-task"
      >
        <UserPlus className="h-3.5 w-3.5" />
      </button>

      {open && (
        <VibeAssignTaskDialog
          open={open}
          onOpenChange={setOpen}
          projectId={projectId}
          sessionTypeId={sessionTypeId}
        />
      )}
    </>
  );
}
