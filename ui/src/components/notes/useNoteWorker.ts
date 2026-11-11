import { t } from '@lingui/core/macro';
import { useCallback, useMemo, useState } from 'react';
import { AgenticProcess, Annotation, dataContext, ProcessKind, TypeId } from '@sdk';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { buildSharedAndPrivateContextSection } from '@src/components/conversation/prompt-building';
import { mostRecentProcess } from '@src/utils/process-recency';
import type { WorkerType } from '@src/components/workers/worker-types';

/** The note and the entity it sits on — the worker's whole context, in that order. */
export function noteWorkerContext(note: Annotation): TypeId[] {
  const out = [new TypeId(Annotation.type, note.id)];
  if (note.target_type && note.target_id) out.push(new TypeId(note.target_type, note.target_id));
  return out;
}

/**
 * The prompt a note's worker starts with. Built in the background and never
 * shown: the user sees only the toolbar. The note's text rides in full; the
 * context section lists the note and its entity so the worker can read both.
 */
export function buildNotePrompt(note: Annotation): string {
  const name = (note.data?.name as string | undefined) || `${note.target_type}/${note.target_id}`;
  const intro = `You are working on ${name} (${note.target_type}/${note.target_id}) and here is the note the user left on it:\n\n${(note.content ?? '').trim()}`;
  const ctx = buildSharedAndPrivateContextSection(noteWorkerContext(note), []);
  return ctx ? `${intro}\n\n${ctx}` : intro;
}

/**
 * Context worker for one note — the note-popup twin of `useTranscriptSession`.
 * The worker is an Analysis process targeted at the note, so the backend's
 * `pair_analysis_context` links note ↔ process both ways, and an existing one
 * is rediscovered by target (the toolbar then shows "Open <session>").
 */
export function useNoteWorker(note: Annotation | null) {
  const { navigation } = useDockNavigation();
  const [starting, setStarting] = useState(false);
  const target = note?.id ? new TypeId(Annotation.type, note.id).toString() : null;
  const { processes } = useProcessesForTarget(target, { processType: ProcessKind.Analysis });
  const process = useMemo(() => mostRecentProcess(processes), [processes]);

  const launch = useCallback(
    (worker: WorkerType) => {
      const LOG = '[useNoteWorker]';
      if (!note || !target || starting) {
        console.warn(`${LOG} launch did NOT start — note=${note?.id ?? 'null'} starting=${starting}`);
        return;
      }
      const project = dataContext.project;
      const workdir = project?.fs_storage_mount_path ?? undefined;
      if (!workdir) {
        console.warn(`${LOG} launch did NOT start — the active project has no folder on this machine`);
        notify.error({ title: t`No active project`, message: t`Open a project to work on this note.` });
        return;
      }
      setStarting(true);
      void AgenticProcess.launch({
        workerType: worker,
        workdir,
        projectId: project?.id ?? undefined,
        launchPrompt: buildNotePrompt(note),
        enableAssistant: true,
        processType: ProcessKind.Analysis,
        sharedContextEntities: noteWorkerContext(note).map((tid) => tid.toString()),
        target,
      })
        .catch((err) => {
          console.error(`${LOG} AgenticProcess.launch threw`, err);
          notify.error({ title: t`Failed to start session` });
        })
        .finally(() => setStarting(false));
    },
    [note, target, starting],
  );

  const open = useCallback(() => {
    if (process?.id) void navigation.openShellProcess(process.id);
  }, [process, navigation]);

  return { process, starting, launch, open };
}
