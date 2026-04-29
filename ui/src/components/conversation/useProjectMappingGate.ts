import { useCallback, useEffect, useRef, useState } from 'react';
import type { ITask } from '@sdk/entities/task';

/**
 * Imperative gate for actions that need a project (cwd) — Start Claude Code,
 * Approve & Execute, Open in Project, etc. The dialog only appears the first
 * time an action actually needs the project; once the user picks one, the
 * action automatically resumes.
 *
 * The gate watches `task.metadata.project_root` for the transition from
 * unset → set: whenever a continuation is pending and that flips, the
 * continuation runs and the dialog closes. Driving it off observed state
 * (rather than the dialog's `onPicked` callback firing) means it works
 * regardless of which picker component is mounted and what its callback
 * timing happens to be.
 *
 * Usage:
 * ```tsx
 * const gate = useProjectMappingGate(task);
 * // mount: <OpenProjectComponent {...gate.dialogProps} />
 * // pass down: gate.ensureMapped(continuation)
 * ```
 */
export function useProjectMappingGate(task: ITask | null | undefined) {
  const [open, setOpen] = useState(false);
  const continuationRef = useRef<(() => void | Promise<void>) | null>(null);

  const taskMeta = (task?.metadata as Record<string, unknown> | undefined) ?? {};
  const remoteProjectId = taskMeta.remote_project_id as string | undefined;
  const remoteProjectName = (taskMeta.remote_project_name as string | undefined) ?? '';
  const projectRoot = taskMeta.project_root as string | undefined;
  const hasMapping = !!projectRoot;

  const ensureMapped = useCallback(
    (continuation: () => void | Promise<void>) => {
      if (hasMapping) {
        void continuation();
        return;
      }
      continuationRef.current = continuation;
      setOpen(true);
    },
    [hasMapping],
  );

  // Watch for the mapping flipping from unset → set while a continuation is
  // pending. Defer one tick so React state (the picker's setCurrentProject,
  // task entity refresh) finishes committing before the action runs.
  useEffect(() => {
    if (!hasMapping || !continuationRef.current) return;
    const cont = continuationRef.current;
    continuationRef.current = null;
    setOpen(false);
    const handle = window.setTimeout(() => {
      void cont();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [hasMapping]);

  const dialogProps = {
    open,
    onOpenChange: (next: boolean) => {
      setOpen(next);
      // Treat a manual close (no mapping written) as a cancel — drop the
      // pending continuation so it doesn't fire on some unrelated future
      // mapping change. The successful-pick path closes the dialog from
      // inside the effect above, by which point the ref is already null.
      if (!next && !hasMapping) continuationRef.current = null;
    },
    taskId: task?.id ?? undefined,
    remoteProjectId: remoteProjectId ?? null,
    remoteProjectName,
    trigger: (remoteProjectId ? 'map' : 'gate') as 'map' | 'gate',
  };

  return { ensureMapped, dialogProps };
}
