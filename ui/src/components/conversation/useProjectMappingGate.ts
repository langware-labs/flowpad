import { useEffect, useRef } from 'react';
import { dataManager, Project, TypeId } from '@sdk';
import type { ITask } from '@sdk/entities/task';
import type { IConversation } from '@sdk/entities/conversation';
import { useContext } from '@src/hooks/useContext';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  applyProjectToConversation,
  applyProjectToTask,
  persistRemoteToLocalMapping,
} from './apply-project-choice';
import { useProjectGate } from './useProjectGate';
import { useProjectMapping } from './useProjectMapping';

/**
 * Imperative gate for actions that need a project (cwd) — Start Claude Code,
 * Approve & Execute, Open in Project, etc. The dialog only appears the first
 * time an action actually needs the project; once the user picks one, the
 * action automatically resumes.
 *
 * The "subject" of the mapping is whichever entity anchors this view:
 *   - Task-bound conversation → stamp the task (and its child conversation).
 *   - Task-less conversation  → stamp the conversation directly.
 *
 * The remote provenance (`remote_project_id` / `remote_project_name`) always
 * lives on the **Conversation** — task-bound or not. The gate reads it from
 * there. The mapping table key is unchanged (`remote_project_id` →
 * `local_project_id`), so a sender's project routes to the same local project
 * regardless of whether it arrives wrapped in a task.
 *
 * Three layers of resolution:
 *   1. Subject already mapped (task has `project_root`, or conv has
 *      `project_id`) → no dialog.
 *   2. Subject unmapped, but the per-machine mapping table has an entry for
 *      this conversation's `remote_project_id` → silently fetch the local
 *      Project and stamp the subject. No dialog.
 *   3. Neither — open the picker the next time an action needs a project.
 *
 * The gate watches `mapped` for the unset → set transition; whenever a
 * continuation is pending and that flips, the continuation runs and the
 * dialog closes.
 */
export function useProjectMappingGate(
  task: ITask | null | undefined,
  conversation?: IConversation | null,
) {
  const { mapping, loaded: mappingLoaded } = useProjectMapping();
  const ctx = useContext();
  const { navigation } = useDockNavigation();
  const autoApplyAttemptedRef = useRef<Set<string>>(new Set());
  const autoMapAttemptedRef = useRef<Set<string>>(new Set());

  // Remote provenance always lives on the conversation (task-bound or not).
  const remoteProjectId = conversation?.remote_project_id ?? undefined;
  const remoteProjectName = conversation?.remote_project_name ?? '';

  // The "subject" being stamped: task wins when present (it owns project_root
  // for cwd); otherwise the conversation itself is the subject.
  const taskId = task?.id ?? '';
  const conversationId = conversation?.id ?? '';
  const subjectKey = taskId || conversationId;

  // "Already mapped?" check differs by subject:
  //   - Task subject: project_root is set (the cwd is known).
  //   - Conv subject: project_id is set (the local Project is known; conv has
  //     no project_root field — the workdir comes from the Project entity).
  const taskProjectRoot = task?.project_root ?? undefined;
  const convProjectId = conversation?.project_id ?? undefined;
  const subjectMapped = task ? !!taskProjectRoot : !!convProjectId;

  const mappedLocalId = remoteProjectId ? mapping[remoteProjectId] : undefined;
  // Either the subject is already mapped, or the mapping table tells us which
  // local project to use. The auto-apply effect below converts the second
  // case into the first as soon as the table is loaded.
  const hasMapping = subjectMapped || !!mappedLocalId;

  // Unconditional state trace — fires every time the relevant inputs change.
  // Lets us see at a glance which guard is short-circuiting the auto-apply.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[project-mapping] gate state', {
      subjectKey,
      subjectKind: task ? 'task' : conversation ? 'conversation' : 'none',
      taskId: taskId || null,
      conversationId: conversationId || null,
      taskProjectRoot: taskProjectRoot ?? null,
      convProjectId: convProjectId ?? null,
      remoteProjectId: remoteProjectId ?? null,
      mappingLoaded,
      mapping,
      mappedLocalId: mappedLocalId ?? null,
      hasMapping,
    });
  }, [
    subjectKey, taskId, conversationId, taskProjectRoot, convProjectId,
    remoteProjectId, mappingLoaded, mapping, mappedLocalId, hasMapping,
    task, conversation,
  ]);

  // Stamp helper — chooses task vs conversation based on which subject we have.
  // Returns `wasReplacement=true` when the conversation previously pointed at
  // a *different* project (drives the Feature-1 navigate-on-remap behavior).
  const stampSubject = async (project: Project) => {
    if (taskId) return applyProjectToTask(taskId, project);
    if (conversationId) return applyProjectToConversation(conversationId, project);
    return { saved: false, wasReplacement: false };
  };

  // Feature 1: when the conversation already had a project and the user picks
  // a new one, send them to the new project's home.
  const navigateToProjectHome = (projectId: string | null | undefined) => {
    if (!projectId) return;
    navigation.openDock(DockPointer.forProject(projectId));
  };

  // Auto-apply the saved mapping when it exists for this remote project but
  // the subject hasn't been stamped yet. Runs once per subject; further
  // changes require explicit user action.
  useEffect(() => {
    if (subjectMapped) return;
    if (!mappingLoaded) return;
    if (!remoteProjectId || !mappedLocalId || !subjectKey) return;
    if (autoApplyAttemptedRef.current.has(subjectKey)) return;
    autoApplyAttemptedRef.current.add(subjectKey);

    void (async () => {
      // eslint-disable-next-line no-console
      console.log('[project-mapping] auto-apply firing', {
        subjectKey,
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
        await stampSubject(project);
        // eslint-disable-next-line no-console
        console.log('[project-mapping] auto-apply: stamped subject', { subjectKey, project_id: project.id });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[project-mapping] auto-apply failed', err);
      }
    })();
  }, [subjectMapped, mappingLoaded, remoteProjectId, mappedLocalId, subjectKey, mapping]);

  // Safety net: regardless of how the user picked the active project (toolbar
  // gate, footer "Select Project" pill, project switcher in any other view),
  // when the user *changes* the active project while this subject is in view
  // and the subject is still unmapped, persist the mapping and stamp the
  // subject. We only react to a change (initialActiveRef captured on mount) —
  // the footer's pre-existing default project must not be auto-adopted as the
  // mapping for an unrelated remote_project_id.
  const activeProjectId = ctx.project?.id ?? null;
  const initialActiveRef = useRef<{ subjectKey: string; activeProjectId: string | null } | null>(null);
  useEffect(() => {
    if (!mappingLoaded) return;
    if (!subjectKey) return;
    // Two reasons to fire:
    //   - remote provenance: write the per-machine mapping table.
    //   - existing local project: detect a remap so we can navigate (Feature 1).
    // If neither applies, the conversation is fresh-and-local and we leave
    // claim-on-context-change to the explicit creation flow (Feature 2).
    const isRemap = !!convProjectId && convProjectId !== activeProjectId;
    if (!remoteProjectId && !isRemap) return;
    // Capture the active project at the moment this subject first becomes
    // observable to the gate. Any subsequent change (or change-from-null) is
    // treated as a user pick.
    if (!initialActiveRef.current || initialActiveRef.current.subjectKey !== subjectKey) {
      initialActiveRef.current = { subjectKey, activeProjectId };
      return;
    }
    if (initialActiveRef.current.activeProjectId === activeProjectId) return;
    if (!activeProjectId) return;
    // Already mapped (table-side) to this project — skip the table write but
    // still let the subject stamp run (the subject may still be unstamped).
    const tableAgrees = !!remoteProjectId && mapping[remoteProjectId] === activeProjectId;
    const key = `${subjectKey}:${remoteProjectId ?? ''}:${activeProjectId}`;
    if (autoMapAttemptedRef.current.has(key)) return;
    autoMapAttemptedRef.current.add(key);

    void (async () => {
      // eslint-disable-next-line no-console
      console.log('[project-mapping] auto-persist firing', {
        subjectKey,
        remoteProjectId,
        activeProjectId,
        existingMapping: remoteProjectId ? (mapping[remoteProjectId] ?? null) : null,
        previousLocalProjectId: convProjectId ?? null,
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
        const r = await stampSubject(project);
        if (remoteProjectId && project.id && !tableAgrees) {
          await persistRemoteToLocalMapping(remoteProjectId, project.id);
        }
        if (r.wasReplacement) navigateToProjectHome(project.id);
        // eslint-disable-next-line no-console
        console.log('[project-mapping] auto-persist: stamped + mapped', {
          subjectKey,
          remoteProjectId,
          localProjectId: project.id,
          wasReplacement: r.wasReplacement,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[project-mapping] auto-persist failed', err);
      }
    })();
  }, [mappingLoaded, remoteProjectId, subjectKey, activeProjectId, convProjectId, mapping]);

  const apply = async (project: Project) => {
    const r = await stampSubject(project);
    if (remoteProjectId && project.id) await persistRemoteToLocalMapping(remoteProjectId, project.id);
    if (r.wasReplacement) navigateToProjectHome(project.id);
  };

  return useProjectGate({
    mapped: hasMapping,
    apply,
    trigger: remoteProjectId ? 'map' : 'gate',
    remoteProjectName,
    taskId: taskId || null,
    remoteProjectId: remoteProjectId ?? null,
    // Hold the picker closed until the per-machine mapping table has loaded.
    // Otherwise an `ensureMapped` call could open the dialog for one frame
    // before auto-apply silently resolves the mapping behind it.
    ready: mappingLoaded,
  });
}
