import { useCallback, useRef, useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import { useProjectMapping } from './useProjectMapping';

/**
 * Imperative gate for actions that need a project (cwd) — Start Claude Code,
 * Approve & Execute, etc. Replaces the old "open the mapping dialog at the
 * top of the conversation" flow: instead, the dialog only appears the first
 * time an action actually needs the project, and the action automatically
 * resumes once the user picks one.
 *
 * Usage from the parent (SharedTaskView / TaskDetailPanel):
 *
 * ```tsx
 * const gate = useProjectMappingGate(task);
 * // mount: <ProjectMappingDialog ...{...gate.dialogProps} />
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
  // The only signal that matters for "can we run a Claude session for this
  // task" is whether the task has a concrete project_root stamped on it.
  // Looking at the in-memory mapping table or assuming-mapped-when-no-remote-id
  // both produced false-positives where the gate skipped the dialog and the
  // action then bailed for missing workdir. Project_root is the source of
  // truth; everything else is a hint.
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
    onClose: () => {
      setOpen(false);
      continuationRef.current = null;
    },
    remoteProjectId: remoteProjectId ?? '',
    remoteProjectName,
    taskId: task?.id ?? '',
    onMapped: () => {
      setOpen(false);
      const cont = continuationRef.current;
      continuationRef.current = null;
      // Defer so the task entity's mapping write lands before the
      // continuation reads task.metadata.project_root.
      if (cont) setTimeout(() => void cont(), 0);
    },
  };

  return { ensureMapped, dialogProps };
}
