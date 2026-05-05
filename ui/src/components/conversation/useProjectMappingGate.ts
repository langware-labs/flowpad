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
 * Gate for actions that need a project (cwd) — Start CC, Approve & Execute,
 * Open in Project. Wraps `useProjectGate` with the remote→local mapping table
 * + auto-apply + auto-persist on ctx.project changes.
 *
 * The "subject" is the task when present (it owns project_root for cwd) or
 * the conversation otherwise. Remote provenance always lives on the
 * conversation; the local mapping target lives on whichever side the loader
 * already prefers (`task.project_id ?? conv.project_id`).
 *
 * Three resolution layers:
 *   1. Subject already mapped → no dialog.
 *   2. Mapping table has an entry for `conv.remote_project_id` → silently
 *      stamp the subject. No dialog.
 *   3. Neither → dialog opens on next ensureMapped() call.
 *
 * Feature 1: when the subject already had a project and the user picks a
 * different one (via this gate's picker OR by changing ctx.project from any
 * other UI), navigate to the new project's home. The conversation's
 * `project_id` is **not** rewritten — picking a different project from a
 * mapped conversation is a navigation shortcut, not a re-mapping. Re-mapping
 * is reserved for the explicit gate flow on a still-unmapped subject.
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

  const taskId = task?.id ?? '';
  const conversationId = conversation?.id ?? '';
  const subjectKey = taskId || conversationId;

  const remoteProjectId = conversation?.remote_project_id ?? undefined;
  const remoteProjectName = conversation?.remote_project_name ?? '';

  // Local project this view is filed under, from whichever side carries it
  // (same precedence the page loader uses for ctx.project).
  const existingLocalProjectId =
    task?.project_id ?? conversation?.project_id ?? null;

  const mappedLocalId = remoteProjectId ? mapping[remoteProjectId] : undefined;
  const hasMapping = !!existingLocalProjectId || !!mappedLocalId;

  const fetchProject = (id: string) =>
    dataManager.getByTypeId<Project>(new TypeId(Project.type, id)).catch(() => null);

  const stampSubject = async (project: Project) => {
    if (taskId) await applyProjectToTask(taskId, project);
    else if (conversationId) await applyProjectToConversation(conversationId, project);
  };

  // Snapshot at call time — accurate even when the conv mirror isn't in sync
  // with task.project_id, because we read whichever side carries it.
  const isRemapTo = (newId: string | null | undefined) =>
    !!existingLocalProjectId && existingLocalProjectId !== (newId ?? null);

  const navigateToProjectHome = (projectId: string | null | undefined) => {
    if (projectId) navigation.openDock(DockPointer.forProject(projectId));
  };

  // Auto-apply: mapping table → silent stamp. Once per subject.
  useEffect(() => {
    if (existingLocalProjectId) return;
    if (!mappingLoaded || !remoteProjectId || !mappedLocalId || !subjectKey) return;
    if (autoApplyAttemptedRef.current.has(subjectKey)) return;
    autoApplyAttemptedRef.current.add(subjectKey);

    void (async () => {
      const project = await fetchProject(mappedLocalId);
      if (project) await stampSubject(project);
    })();
  }, [existingLocalProjectId, mappingLoaded, remoteProjectId, mappedLocalId, subjectKey]);

  // Auto-persist: ctx.project change while this subject is in view → write
  // mapping table (if remote), stamp subject, navigate on remap. We only react
  // to a *change* from the value captured at first observation — the footer's
  // pre-existing default project must not be auto-adopted as a mapping for an
  // unrelated remote conversation.
  const activeProjectId = ctx.project?.id ?? null;
  const initialActiveRef = useRef<{ subjectKey: string; activeProjectId: string | null } | null>(null);
  useEffect(() => {
    if (!mappingLoaded || !subjectKey) return;
    if (!remoteProjectId && !isRemapTo(activeProjectId)) return;

    if (initialActiveRef.current?.subjectKey !== subjectKey) {
      initialActiveRef.current = { subjectKey, activeProjectId };
      return;
    }
    if (initialActiveRef.current.activeProjectId === activeProjectId) return;
    if (!activeProjectId) return;

    const dedupeKey = `${subjectKey}:${remoteProjectId ?? ''}:${activeProjectId}`;
    if (autoMapAttemptedRef.current.has(dedupeKey)) return;
    autoMapAttemptedRef.current.add(dedupeKey);

    // Remap = navigate only. The conversation keeps its existing project; the
    // user is using the picker as a shortcut to jump to a different project,
    // not to re-file this conversation. Skip stamping + skip mapping-table
    // write for the same reason — a mapping-table edit would re-route the
    // *next* incoming message from the same remote sender, which the user
    // hasn't asked for.
    if (isRemapTo(activeProjectId)) {
      navigateToProjectHome(activeProjectId);
      return;
    }

    // First-time map (subject was unmapped): stamp it + write mapping table.
    void (async () => {
      const project = await fetchProject(activeProjectId);
      if (!project) return;
      await stampSubject(project);
      if (remoteProjectId && project.id && mapping[remoteProjectId] !== project.id) {
        await persistRemoteToLocalMapping(remoteProjectId, project.id);
      }
    })();
  }, [mappingLoaded, remoteProjectId, subjectKey, activeProjectId, existingLocalProjectId, mapping]);

  // Direct pick (gate's own dialog → onPicked). The picker only opens when
  // unmapped, so this is always a first-time map — no remap branch needed.
  const apply = async (project: Project) => {
    await stampSubject(project);
    if (remoteProjectId && project.id) {
      await persistRemoteToLocalMapping(remoteProjectId, project.id);
    }
  };

  return useProjectGate({
    mapped: hasMapping,
    apply,
    trigger: remoteProjectId ? 'map' : 'gate',
    remoteProjectName,
    taskId: taskId || null,
    remoteProjectId: remoteProjectId ?? null,
    // Hold the picker closed until the mapping table loads — otherwise it can
    // flash open for one frame before auto-apply silently resolves.
    ready: mappingLoaded,
  });
}
