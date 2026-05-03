import { useCallback, useEffect, useRef, useState } from 'react';
import { dataManager, Project, TypeId } from '@sdk';
import type { ITask } from '@sdk/entities/task';
import { useContext } from '@src/hooks/useContext';
import { applyProjectToTask, persistRemoteToLocalMapping } from './apply-project-choice';
import { useProjectMapping } from './useProjectMapping';

/**
 * Imperative gate for actions that need a project (cwd) — Start Claude Code,
 * Approve & Execute, Open in Project, etc. The dialog only appears the first
 * time an action actually needs the project; once the user picks one, the
 * action automatically resumes.
 *
 * Three layers of resolution:
 *   1. `task.project_root` already set → mapped, no dialog.
 *   2. `task.project_root` missing but the per-machine mapping table
 *      has an entry for this task's `remote_project_id` → silently fetch the
 *      local Project and stamp the task. No dialog. This is what makes a
 *      *second* message from the same remote project route automatically
 *      after the receiver picked once.
 *   3. Neither — open the picker the next time an action needs a project.
 *
 * The gate watches `task.project_root` for the unset → set transition;
 * whenever a continuation is pending and that flips, the continuation runs and
 * the dialog closes. Driving it off observed state (rather than the picker's
 * `onPicked` callback firing) means it works regardless of which picker
 * component is mounted and what its callback timing happens to be — including
 * the silent auto-resolve in (2).
 */
export function useProjectMappingGate(task: ITask | null | undefined) {
  const { mapping, loaded: mappingLoaded } = useProjectMapping();
  const ctx = useContext();
  const [open, setOpen] = useState(false);
  const continuationRef = useRef<(() => void | Promise<void>) | null>(null);
  const autoApplyAttemptedRef = useRef<Set<string>>(new Set());
  const autoMapAttemptedRef = useRef<Set<string>>(new Set());

  const remoteProjectId = task?.remote_project_id ?? undefined;
  const remoteProjectName = task?.remote_project_name ?? '';
  const projectRoot = task?.project_root ?? undefined;
  const taskId = task?.id ?? '';

  const mappedLocalId = remoteProjectId ? mapping[remoteProjectId] : undefined;
  // Either the task already has its own root, or the mapping table tells us
  // which local project to use. The auto-apply effect below converts the
  // second case into the first as soon as the table is loaded.
  const hasMapping = !!projectRoot || !!mappedLocalId;

  // Unconditional state trace — fires every time the relevant inputs change.
  // Lets us see at a glance which guard is short-circuiting the auto-apply.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[project-mapping] gate state', {
      taskId,
      projectRoot: projectRoot ?? null,
      remoteProjectId: remoteProjectId ?? null,
      mappingLoaded,
      mapping,
      mappedLocalId: mappedLocalId ?? null,
      hasMapping,
    });
  }, [taskId, projectRoot, remoteProjectId, mappingLoaded, mapping, mappedLocalId, hasMapping]);

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
      // eslint-disable-next-line no-console
      console.log('[project-mapping] auto-apply firing', {
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
        // eslint-disable-next-line no-console
        console.log('[project-mapping] auto-apply: stamped task', { taskId, project_id: project.id });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[project-mapping] auto-apply failed', err);
      }
    })();
  }, [projectRoot, mappingLoaded, remoteProjectId, mappedLocalId, taskId, mapping]);

  // Safety net: regardless of how the user picked the active project (toolbar
  // gate, footer "Select Project" pill, project switcher in any other view),
  // when the user *changes* the active project while this task is in view and
  // the task is still unmapped, persist the mapping and stamp the task. We
  // only react to a change (initialActiveRef captured on mount) — the footer's
  // pre-existing default project must not be auto-adopted as the mapping for
  // an unrelated remote_project_id.
  const activeProjectId = ctx.project?.id ?? null;
  const initialActiveRef = useRef<{ taskId: string; activeProjectId: string | null } | null>(null);
  useEffect(() => {
    if (!mappingLoaded) return;
    if (!remoteProjectId || !taskId) return;
    // Capture the active project at the moment this task first becomes
    // observable to the gate. Any subsequent change (or change-from-null) is
    // treated as a user pick.
    if (!initialActiveRef.current || initialActiveRef.current.taskId !== taskId) {
      initialActiveRef.current = { taskId, activeProjectId };
      return;
    }
    if (initialActiveRef.current.activeProjectId === activeProjectId) return;
    if (!activeProjectId) return;
    // Already mapped to this project — nothing to persist.
    if (mapping[remoteProjectId] === activeProjectId) return;
    const key = `${taskId}:${remoteProjectId}:${activeProjectId}`;
    if (autoMapAttemptedRef.current.has(key)) return;
    autoMapAttemptedRef.current.add(key);

    void (async () => {
      // eslint-disable-next-line no-console
      console.log('[project-mapping] auto-persist firing', {
        taskId,
        remoteProjectId,
        activeProjectId,
        existingMapping: mapping[remoteProjectId] ?? null,
      });
      try {
        const project = await dataManager
          .getByTypeId<Project>(new TypeId(Project.type, activeProjectId))
          .catch(() => null);
        if (!project) {
          // eslint-disable-next-line no-console
          console.warn('[project-mapping] auto-persist: active project not found', activeProjectId);
          return;
        }
        await applyProjectToTask(taskId, project);
        await persistRemoteToLocalMapping(remoteProjectId, project.id ?? null);
        // eslint-disable-next-line no-console
        console.log('[project-mapping] auto-persist: stamped + mapped', {
          taskId,
          remoteProjectId,
          localProjectId: project.id,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[project-mapping] auto-persist failed', err);
      }
    })();
  }, [mappingLoaded, remoteProjectId, taskId, activeProjectId, mapping]);

  const ensureMapped = useCallback(
    (continuation: () => void | Promise<void>) => {
      if (hasMapping) {
        void continuation();
        return;
      }
      continuationRef.current = continuation;
      if (mappingLoaded) setOpen(true);
    },
    [hasMapping, mappingLoaded],
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

  // If the mapping table finishes loading and we *still* have no mapping
  // for this remote project, only then commit to the picker — the user has
  // a pending action that genuinely needs a fresh choice.
  useEffect(() => {
    if (!mappingLoaded) return;
    if (hasMapping) return;
    if (!continuationRef.current) return;
    setOpen(true);
  }, [mappingLoaded, hasMapping]);

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
