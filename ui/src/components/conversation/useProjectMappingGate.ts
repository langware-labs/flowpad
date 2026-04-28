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
export function useProjectMappingGate(task: ITask) {
  const { mapping, loaded } = useProjectMapping();
  const [open, setOpen] = useState(false);
  const continuationRef = useRef<(() => void | Promise<void>) | null>(null);

  const taskMeta = (task.metadata as Record<string, unknown> | undefined) ?? {};
  const remoteProjectId = taskMeta.remote_project_id as string | undefined;
  const remoteProjectName = (taskMeta.remote_project_name as string | undefined) ?? '';
  const projectRoot = taskMeta.project_root as string | undefined;
  // Mapped if: the task already has its own project_root stamped (sender's
  // path, OR a previously-resolved receiver mapping), OR there's no remote
  // project to map (purely-local task), OR the in-memory mapping table has
  // a hit for the remote_project_id.
  const hasMapping =
    !!projectRoot
    || !remoteProjectId
    || (loaded && !!mapping[remoteProjectId]);

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
    taskId: task.id ?? '',
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
