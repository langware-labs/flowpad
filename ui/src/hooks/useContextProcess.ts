import { useCallback, useMemo, useState } from 'react';
import { AgenticProcess, GraphContext, Project, TypeId } from '@sdk';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { resolveWorkdir } from '@src/components/conversation/apply-project-choice';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { mostRecentProcess } from '@src/utils/process-recency';

/**
 * Generic "context process" launch-or-resume — the §4 grid action.
 *
 * Given a declared context (a set of entity typeids) keyed by a stable `target`,
 * returns the most-recent process bound to that context plus one smart action
 * that RESUMES it if one exists, else LAUNCHES a new one — capturing the context
 * as a `GraphContext` and binding it (`set-graph-context`) so the worker is told
 * what it is working on (contextProcess.md).
 *
 * Reused across every surface whose context is >1 entity (per-message first, then
 * diagnose / analysis, …): only `target` + `contextTypeids` differ. The launch is
 * headless because `set_graph_context` must bind BEFORE the worker's session
 * exists (it freezes once a transcript is keyed).
 *
 * When the surface has no project (or one with no local workdir) the launch
 * can't resolve a cwd. That is a missing INPUT, not an error: the hook raises
 * `needsProject` so the caller can show the project picker, and the pick
 * resumes the very same launch through {@link launchWithProject}.
 */
export function useContextProcess(opts: {
  /** Reuse key (`target_typeid_str`) — the identity entity, e.g. the message typeid. */
  target: string | null;
  /** The full context: the typeids folded into the worker's summary. */
  contextTypeids: string[];
  /** Project the worker runs in (resolves the cwd + the GraphContext save scope). */
  projectId?: string | null;
  /** GraphContext display name. */
  name?: string;
  workerType?: 'claude_code' | 'codex' | 'copilot';
  /** Gate the resume lookup — pass `false` while the control is hidden so the
   *  per-target query doesn't run for every message that mounts this hook. */
  enabled?: boolean;
}): {
  existing: AgenticProcess | null;
  busy: boolean;
  openOrLaunch: () => void;
  /** The click found no usable project — render the project picker. */
  needsProject: boolean;
  /** Close the picker without launching (user dismissed it). */
  dismissProjectPicker: () => void;
  /** Continue the pending launch with the project the user just picked. */
  launchWithProject: (projectId: string) => void;
} {
  const { navigation } = useDockNavigation();
  const { processes } = useProcessesForTarget(opts.target, { enabled: opts.enabled });
  const [busy, setBusy] = useState(false);
  const [needsProject, setNeedsProject] = useState(false);

  const existing = useMemo(() => mostRecentProcess(processes), [processes]);

  const { target, contextTypeids, projectId, name, workerType } = opts;

  /** The launch itself. `false` ⇒ the project yielded no workdir (caller asks). */
  const launchFor = useCallback(
    async (launchProjectId: string | null | undefined): Promise<boolean> => {
      const workdir = await resolveWorkdir(launchProjectId);
      if (!workdir) return false;

      const gc = new GraphContext({});
      gc.context_typeids = contextTypeids;
      gc.name = name ?? `Context ${gc.id.slice(0, 8)}`;
      const scope = launchProjectId ? [new TypeId(Project.type, launchProjectId)] : [];
      await gc.save(scope);

      // Headless so set-graph-context binds before the worker's session exists.
      const proc = await AgenticProcess.launch({
        ...(workerType ? { workerType } : {}),
        workdir,
        projectId: launchProjectId ?? undefined,
        target: target!,
        sharedContextEntities: contextTypeids,
        enableAssistant: true,
        ptyMode: false,
      });
      if (proc.id) await proc.setGraphContext(gc.id);
      return true;
    },
    [contextTypeids, name, target, workerType],
  );

  /** Shared launch wrapper: one busy flag, one error toast. */
  const runLaunch = useCallback(
    (launchProjectId: string | null | undefined, onNoWorkdir: () => void) => {
      if (busy || !target) return;
      setBusy(true);
      void (async () => {
        try {
          if (!(await launchFor(launchProjectId))) onNoWorkdir();
        } catch (err) {
          console.error('[useContextProcess] launch failed', err);
          notify.error({ title: 'Failed to start context process' });
        } finally {
          setBusy(false);
        }
      })();
    },
    [busy, target, launchFor],
  );

  const openOrLaunch = useCallback(() => {
    // Resume: open the last process bound to this context.
    if (existing?.id) {
      void navigation.openShellProcess(existing.id);
      return;
    }
    // No project yet → ask for one; the pick resumes this launch.
    runLaunch(projectId, () => setNeedsProject(true));
  }, [existing, navigation, projectId, runLaunch]);

  const launchWithProject = useCallback(
    (pickedProjectId: string) => {
      setNeedsProject(false);
      runLaunch(pickedProjectId, () => notify.error({ title: 'That project has no local workdir' }));
    },
    [runLaunch],
  );

  const dismissProjectPicker = useCallback(() => setNeedsProject(false), []);

  return { existing, busy, openOrLaunch, needsProject, dismissProjectPicker, launchWithProject };
}
