import { useCallback, useEffect, useRef, useState } from 'react';
import { dataManager, Project, TypeId } from '@sdk';
import type { ITask } from '@sdk/entities/task';
import { applyProjectToTask } from './apply-project-choice';
import { useProjectMapping } from './useProjectMapping';

/**
 * Imperative gate for actions that need a project (cwd) — Start Claude Code,
 * Approve & Execute, Open in Project, etc. The dialog only appears the first
 * time an action actually needs the project; once the user picks one, the
 * action automatically resumes.
 *
 * Three layers of resolution:
 *   1. `task.metadata.project_root` already set → mapped, no dialog.
 *   2. `task.metadata.project_root` missing but the per-machine mapping table
 *      has an entry for this task's `remote_project_id` → silently fetch the
 *      local Project and stamp the task. No dialog. This is what makes a
 *      *second* message from the same remote project route automatically
 *      after the receiver picked once.
 *   3. Neither — open the picker the next time an action needs a project.
 *
 * The gate watches `task.metadata.project_root` for the unset → set transition;
 * whenever a continuation is pending and that flips, the continuation runs and
 * the dialog closes. Driving it off observed state (rather than the picker's
 * `onPicked` callback firing) means it works regardless of which picker
 * component is mounted and what its callback timing happens to be — including
 * the silent auto-resolve in (2).
 */
export function useProjectMappingGate(task: ITask | null | undefined) {
  const { mapping, loaded: mappingLoaded } = useProjectMapping();
  const [open, setOpen] = useState(false);
  const continuationRef = useRef<(() => void | Promise<void>) | null>(null);
  const autoApplyAttemptedRef = useRef<Set<string>>(new Set());

  const taskMeta = (task?.metadata as Record<string, unknown> | undefined) ?? {};
  const remoteProjectId = taskMeta.remote_project_id as string | undefined;
  const remoteProjectName = (taskMeta.remote_project_name as string | undefined) ?? '';
  const projectRoot = taskMeta.project_root as string | undefined;
  const taskId = task?.id ?? '';

  const mappedLocalId = remoteProjectId ? mapping[remoteProjectId] : undefined;
  // Either the task already has its own root, or the mapping table tells us
  // which local project to use. The auto-apply effect below converts the
  // second case into the first as soon as the table is loaded.
  const hasMapping = !!projectRoot || !!mappedLocalId;

  // Auto-apply the saved mapping when it exists for this remote project but
  // the task hasn't been stamped yet. Runs once per task; further changes
  // require explicit user action.
  useEffect(() => {
    if (projectRoot) return;
    if (!mappingLoaded) return;
    if (!remoteProjectId || !mappedLocalId || !taskId) return;
    if (autoApplyAttemptedRef.current.has(taskId)) return;
    autoApplyAttemptedRef.current.add(taskId);

    void (async () => {
      // Helpful trace — log on the receiver side when we catch a routable
      // mapping that the bundle didn't apply itself. Surfaces "did the
      // mapping table actually persist?" debugging without a UI prompt.
      // eslint-disable-next-line no-console
      console.log('[project-mapping] auto-apply', {
        taskId,
        remoteProjectId,
        mappedLocalId,
        mapping,
      });
      try {
        const project = await dataManager
          .getByTypeId<Project>(new TypeId(Project.type, mappedLocalId))
          .catch(() => null);
        if (!project) {
          // eslint-disable-next-line no-console
          console.warn('[project-mapping] auto-apply: local project not found', mappedLocalId);
          return;
        }
        await applyProjectToTask(taskId, project);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[project-mapping] auto-apply failed', err);
      }
    })();
  }, [projectRoot, mappingLoaded, remoteProjectId, mappedLocalId, taskId, mapping]);

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
