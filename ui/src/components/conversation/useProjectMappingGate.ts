import { useCallback, useRef, useState } from 'react';
import type { ITask } from '@sdk/entities/task';

/**
 * Imperative gate for actions that need a project (cwd) — Start Claude Code,
 * Approve & Execute, Open in Project, etc. The dialog only appears the first
 * time an action actually needs the project; once the user picks one, the
 * action automatically resumes.
 *
 * The dialog itself is `OpenProjectComponent` (the same component the footer's
 * Switch Project button uses) — see #10–14 in the design discussion. We pass
 * it the optional `taskId` + `remoteProjectId` so it stamps task metadata and
 * writes the per-machine remote→local mapping when relevant.
 *
 * Usage from the parent (SharedTaskView / TaskDetailPanel):
 *
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

  const dialogProps = {
    open,
    onOpenChange: (next: boolean) => {
      setOpen(next);
      if (!next) continuationRef.current = null;
    },
    taskId: task?.id ?? undefined,
    remoteProjectId: remoteProjectId ?? null,
    remoteProjectName,
    trigger: (remoteProjectId ? 'map' : 'gate') as 'map' | 'gate',
    onPicked: async () => {
      // setCurrentProjectContext already wrote project_id/project_root to the
      // task before we get here; defer one tick so React state catches up.
      const cont = continuationRef.current;
      continuationRef.current = null;
      if (cont) await new Promise<void>((resolve) => setTimeout(() => { resolve(); }, 0)).then(() => cont());
    },
  };

  return { ensureMapped, dialogProps };
}
