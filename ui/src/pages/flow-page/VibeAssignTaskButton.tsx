import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { TypeId } from '@sdk';
import { FlowIcon } from '@sdk/react/FlowIcon';
import { VibeAssignTaskDialog } from './VibeAssignTaskDialog';
import { workspaceToolbarButton } from './workspace-toolbar-button';

/**
 * "Count me in" — the vibe workspace's SINGLE get-help affordance, marked by
 * the raised-hand figure (the collaborate glyph this replaces; there is no
 * second button beside it). One click, one simple dialog: it creates a TASK,
 * assigns it (so the work lands on the other person's board), and sends them a
 * message carrying the issue plus the task chips and the session transcript.
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
        <FlowIcon icon="flowpad.person-raised-hand" className="h-3.5 w-3.5" />
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
