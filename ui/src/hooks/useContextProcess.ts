import { useCallback, useMemo, useState } from 'react';
import { AgenticProcess, GraphContext, Project, TypeId } from '@sdk';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { resolveWorkdir } from '@src/components/conversation/apply-project-choice';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { mostRecentProcess } from '@src/utils/process-recency';

const DEFAULT_WORKER = 'claude_code' as const;

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
}): { existing: AgenticProcess | null; busy: boolean; openOrLaunch: () => void } {
  const { navigation } = useDockNavigation();
  const { processes } = useProcessesForTarget(opts.target, { enabled: opts.enabled });
  const [busy, setBusy] = useState(false);

  const existing = useMemo(() => mostRecentProcess(processes), [processes]);

  const openOrLaunch = useCallback(() => {
    // Resume: open the last process bound to this context.
    if (existing?.id) {
      void navigation.openShellProcess(existing.id);
      return;
    }
    if (busy || !opts.target) return;
    setBusy(true);
    void (async () => {
      try {
        const workdir = await resolveWorkdir(opts.projectId);
        if (!workdir) {
          notify.error({ title: 'No project workdir for this context' });
          return;
        }
        const gc = new GraphContext({});
        gc.context_typeids = opts.contextTypeids;
        gc.name = opts.name ?? `Context ${gc.id.slice(0, 8)}`;
        const scope = opts.projectId ? [new TypeId(Project.type, opts.projectId)] : [];
        await gc.save(scope);

        // Headless so set-graph-context binds before the worker's session exists.
        const proc = await AgenticProcess.launch({
          workerType: opts.workerType ?? DEFAULT_WORKER,
          workdir,
          projectId: opts.projectId ?? undefined,
          target: opts.target!,
          sharedContextEntities: opts.contextTypeids,
          enableAssistant: true,
          ptyMode: false,
        });
        if (proc.id) await proc.setGraphContext(gc.id);
      } catch (err) {
        console.error('[useContextProcess] launch failed', err);
        notify.error({ title: 'Failed to start context process' });
      } finally {
        setBusy(false);
      }
    })();
  }, [existing, busy, opts.target, opts.contextTypeids, opts.projectId, opts.name, opts.workerType, navigation]);

  return { existing, busy, openOrLaunch };
}
