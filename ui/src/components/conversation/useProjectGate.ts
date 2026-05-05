import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@sdk';

/**
 * Generic "needs a local project mapped" gate. Used by anything that runs
 * Claude headlessly (or otherwise needs a `cwd`) — currently tasks and
 * conversations, but works for any entity whose mapping is reducible to a
 * boolean + an apply callback.
 *
 * The flow:
 *   1. Caller wraps an action with `ensureMapped(action)`.
 *   2. If `mapped` is true, the action runs immediately.
 *   3. Otherwise the dialog opens; the caller renders
 *      `<OpenProjectComponent {...dialogProps} />`.
 *   4. After the user picks, the gate writes the choice via `apply(project)`
 *      and resumes the action once `mapped` flips to true.
 *
 * Watching the boolean (rather than firing the continuation from the picker's
 * own callback) means the same gate works regardless of how the entity gets
 * mapped — direct pick, auto-apply from a remote→local mapping table,
 * footer pill switching the active project. Anything that flips `mapped`
 * resumes the pending action.
 */
export function useProjectGate(opts: {
  mapped: boolean;
  apply: (project: Project) => void | Promise<void>;
  /** Adapts the picker dialog's title + description (see OpenProjectComponent). */
  trigger?: 'switch' | 'map' | 'gate';
  /** Shown in the dialog description for the 'map' trigger. */
  remoteProjectName?: string | null;
  /** Optional pass-through for callsites that already plumb a taskId into the dialog
   *  (the task wrapper sets this so legacy props on OpenProjectComponent remain wired). */
  taskId?: string | null;
  /** Optional pass-through for the remote→local mapping-table flow. */
  remoteProjectId?: string | null;
  /** When false, `ensureMapped` queues the continuation but holds the dialog
   *  closed. The watcher below opens it when this flips to true (still
   *  unmapped). Lets task-mapping callers defer the picker until the
   *  remote→local mapping table has finished loading — otherwise a saved
   *  mapping would auto-apply silently mid-frame and the picker would have
   *  flashed open for nothing. Defaults to true (no deferral). */
  ready?: boolean;
}) {
  const { mapped, apply, trigger, remoteProjectName, taskId, remoteProjectId, ready = true } = opts;
  const [open, setOpen] = useState(false);
  const continuationRef = useRef<(() => void | Promise<void>) | null>(null);

  const ensureMapped = useCallback(
    (continuation: () => void | Promise<void>) => {
      if (mapped) {
        void continuation();
        return;
      }
      continuationRef.current = continuation;
      if (ready) setOpen(true);
    },
    [mapped, ready],
  );

  // Watch for unmapped → mapped while a continuation is pending. Defer one
  // tick so React commits state from the picker (active project switch,
  // entity refetch) before the action runs.
  useEffect(() => {
    if (!mapped || !continuationRef.current) return;
    const cont = continuationRef.current;
    continuationRef.current = null;
    setOpen(false);
    const handle = window.setTimeout(() => {
      void cont();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [mapped]);

  // Loading-window open: the caller invoked `ensureMapped` while `ready` was
  // false (mapping table still loading). Once it flips to true, if we're
  // still unmapped, open the picker.
  useEffect(() => {
    if (!ready || mapped || !continuationRef.current) return;
    setOpen(true);
  }, [ready, mapped]);

  const dialogProps = {
    open,
    onOpenChange: (next: boolean) => {
      setOpen(next);
      // Manual close without a pick → cancel the pending continuation so it
      // doesn't fire on some unrelated future mapping change.
      if (!next && !mapped) continuationRef.current = null;
    },
    onPicked: apply,
    trigger: trigger ?? 'gate',
    remoteProjectName: remoteProjectName ?? undefined,
    taskId: taskId ?? undefined,
    remoteProjectId: remoteProjectId ?? null,
  };

  return { ensureMapped, dialogProps };
}
