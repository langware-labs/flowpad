import { useCallback, useState, type ReactNode } from 'react';
import type { Project } from '@sdk';
import { AddHelpdeskDialog } from '@src/components/helpdesk/AddHelpdeskDialog';

interface UseAddHelpdeskOptions {
  /** The project the desk is adopted by. */
  project: Project | null | undefined;
  /** Ran after the adopt returns — the host passes its project refetch. */
  onAdded?: () => Promise<unknown> | void;
}

/**
 * useAddHelpdesk — the "Add help desk" tile's flow.
 *
 * Its own hook rather than a branch inside {@link useAddContextFolder}: that
 * hook is "the one way to add a context folder, wherever it's offered" and the
 * Assets navigator consumes it independently. A helpdesk branch there would
 * pull the repo/branch pickers and a GitHub status poll into the module graph
 * of a surface that does not offer the source.
 *
 * As with the folder sources, the dialog is rendered by the CALLER through
 * `dialogs`. That is not stylistic: a tile calls `onDone?.()` before its
 * handler, so the panel is already unmounting by the time the source runs, and
 * a dialog owned any closer to the trigger would never appear.
 *
 * `dialogs` mounts the dialog only while it is open — it polls GitHub status
 * and hosts the repo pickers, and every surface that renders this node (the
 * desktop included) would otherwise pay for that on mount.
 */
export function useAddHelpdesk({ project, onAdded }: UseAddHelpdeskOptions) {
  const [open, setOpen] = useState(false);

  // Stable — the panel memoizes tile handlers on this.
  const openDialog = useCallback(() => setOpen(true), []);

  const dialogs: ReactNode = open && project ? (
    <AddHelpdeskDialog open={open} onOpenChange={setOpen} project={project} onAdded={onAdded} />
  ) : null;

  return { open: openDialog, dialogs };
}
