/**
 * loadNextProcess — single recovery primitive for "pick a usable shell tab."
 *
 * Loop:
 *   1. Pull visible shells + processes, build the tab list.
 *   2. Pick the best candidate via `resolveNextTab` (the single
 *      `resolveActive` resolver over the pre-filtered candidates).
 *   3. Try to load it (`loadProcess` for agentic-process tabs, `loadShell`
 *      otherwise).
 *   4. On a typed `ProcessLoadError` / `ShellLoadError`, dispatch the per-kind
 *      cleanup (mirrors what the previous route wrappers did inline), record
 *      the cleanup, mark the id as tried, and advance.
 *   5. Repeat until success, or the candidate set is exhausted.
 *
 * Untyped errors (network 5xx, programming bugs, …) are re-thrown unchanged —
 * they signal "the system is broken," not "this candidate is broken." The
 * caller decides what to do with them.
 *
 * Replaces the URL skip-set machinery (`shell-recovery.ts`) and the per-kind
 * branches that used to live in `routeProcessPointer` / `routePlainShellPointer`.
 */

import { t } from '@lingui/core/macro';
import { AgenticProcess, Shell, tabManager, tabTargetKey, tabsForProject, TypeId } from '@sdk';
import { describeProcessStartError, loadProcess, ProcessLoadError } from './load-process';
import { loadShell, ShellLoadError } from './load-shell';

// ── public types ────────────────────────────────────────────────────────────

export type CleanupKind =
  | 'process_not_found'
  | 'process_start_failed'
  | 'process_no_shell'
  | 'process_project_missing'
  | 'shell_not_found'
  | 'shell_error_status'
  | 'shell_start_failed';

export interface CleanupRecord {
  kind: CleanupKind;
  processId?: string;
  shellId?: string;
  /** User-friendly description of what went wrong — used for the toast on the
   * single-cleanup path. */
  title: string;
  description?: string;
}

export type LoadedNext =
  | { kind: 'process'; process: AgenticProcess; shell: Shell | null }
  | { kind: 'shell'; shell: Shell };

export interface LoadNextProcessOptions {
  /** Candidate ids to skip (process ids and/or shell ids cohabit). Used by
   *  direct-link callers that want to exclude their own already-failed id. */
  excludeIds?: Set<string>;
  /** When set, only consider tabs whose shell/process belongs to this project_id.
   *  Mirrors the per-project filter on the visible tab strip — closing the last
   *  tab in the current project should land on the empty view, not silently
   *  switch the user to a tab in a different project. */
  projectId?: string | null;
}

export interface LoadNextProcessResult {
  /** Successfully-loaded process or shell. `null` when no candidate could be loaded. */
  loaded: LoadedNext | null;
  /** Per-attempt cleanup records, in order. Empty when the first try succeeded. */
  cleaned: CleanupRecord[];
}

// ── per-error cleanup dispatchers (preserve current behaviour) ──────────────

// Exported: also the direct-link cleanup mapper used by load-shell's route loader
// (single source of truth — both the in-loader recovery path and the direct-link
// route map a ProcessLoadError to the same CleanupRecord).
export function buildProcessCleanup(e: ProcessLoadError): CleanupRecord {
  switch (e.kind) {
    case 'entity_not_found':
      return {
        kind: 'process_not_found',
        processId: e.processId,
        title: t`Session not found`,
        description: t`Agentic process does not exist.`,
      };
    case 'network_error': {
      const desc = describeProcessStartError(e.cause ?? e);
      return {
        kind: 'process_start_failed',
        processId: e.processId,
        shellId: e.shellId ?? undefined,
        title: t`Couldn’t reach backend`,
        description: desc.description,
      };
    }
    case 'runtime_terminated':
    case 'pty_attach_failed':
    case 'failed_to_start': {
      const desc = describeProcessStartError(e.cause ?? e);
      return {
        kind: 'process_start_failed',
        processId: e.processId,
        shellId: e.shellId ?? undefined,
        title: desc.title,
        description: desc.description,
      };
    }
    case 'shell_entity_missing':
      return {
        kind: 'process_no_shell',
        processId: e.processId,
        shellId: e.shellId ?? undefined,
        title: t`Session unavailable`,
        description: t`No shell is linked to this process.`,
      };
    case 'project_missing':
      return {
        kind: 'process_project_missing',
        processId: e.processId,
        shellId: e.shellId ?? undefined,
        title: t`Project not found`,
        description: t`Could not recover this session’s project.`,
      };
    default: {
      // Exhaustiveness guard: a missing kind type-errors here; at runtime it
      // returns a generic record rather than undefined (which would crash
      // handleCleanups on `.title`).
      const _exhaustive: never = e.kind;
      void _exhaustive;
      return {
        kind: 'process_start_failed',
        processId: e.processId,
        shellId: e.shellId ?? undefined,
        title: t`Session unavailable`,
        description: t`Failed to restore this session.`,
      };
    }
  }
}

async function buildShellCleanup(e: ShellLoadError): Promise<CleanupRecord> {
  switch (e.kind) {
    case 'not_found':
      return {
        kind: 'shell_not_found',
        shellId: e.shellId,
        title: t`Shell not found`,
        description: t`This terminal no longer exists.`,
      };
    case 'error_status':
      return {
        kind: 'shell_error_status',
        shellId: e.shellId,
        title: t`Shell unavailable`,
        description: e.errorMessage ?? 'Shell error',
      };
    case 'start_failed': {
      // Best-effort close so the user isn't stuck with a zombie row
      // (mirrors the pre-refactor behaviour at routePlainShellPointer:272-273).
      await tabManager.closeTarget(new TypeId(Shell.type, e.shellId)).catch(() => {});
      const desc = describeProcessStartError(e.cause ?? e);
      return {
        kind: 'shell_start_failed',
        shellId: e.shellId,
        title: desc.title,
        description: desc.description,
      };
    }
  }
}

// ── public entry point ──────────────────────────────────────────────────────

export async function loadNextProcess(options: LoadNextProcessOptions = {}): Promise<LoadNextProcessResult> {
  const cleaned: CleanupRecord[] = [];
  const tried = new Set(options.excludeIds ?? []);

  const allTabs = await tabManager.getTerminalTabsSnapshot('all');
  const projectId = options.projectId ?? null;
  const tabs = projectId == null ? allTabs : tabsForProject(allTabs, projectId);

  while (true) {
    const tab = tabManager.resolveNext(tabs, tried);
    if (!tab) {
      return { loaded: null, cleaned };
    }

    const processId = tab.target_type === AgenticProcess.type ? tab.target_id : null;
    if (processId) {
      try {
        const result = await loadProcess(processId);
        return {
          loaded: { kind: 'process', process: result.process, shell: result.shell },
          cleaned,
        };
      } catch (e) {
        if (!(e instanceof ProcessLoadError)) throw e;
        cleaned.push(buildProcessCleanup(e));
        tried.add(processId);
        if (e.shellId) tried.add(e.shellId);
        continue;
      }
    }

    // A shell tab's transport id is its target id (present without any cache);
    // loadShell hydrates the entity on demand below.
    const shellId = tab.target_id;
    if (!shellId) {
      tried.add(tabTargetKey(tab));
      continue;
    }

    try {
      const shell = await loadShell(shellId);
      return { loaded: { kind: 'shell', shell }, cleaned };
    } catch (e) {
      if (!(e instanceof ShellLoadError)) throw e;
      cleaned.push(await buildShellCleanup(e));
      tried.add(shellId);
      continue;
    }
  }
}
