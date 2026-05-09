import type { LucideIcon } from 'lucide-react';
import type { SearchResult } from '@src/hooks/use-record-search';
import { DockPointer } from './DockPointer';
import { ViewType } from '@src/types/ViewType';
import { CheckSquare, Search, GitBranch, FileText } from 'lucide-react';
import { Agent, AgenticProcess, dataContext, Project, RecordType, Skill, Task } from '@sdk';
import { ClaudeSessionRecord } from '@sdk/resource_management/fs_records/claude/claude-session.js';
import type { NavigationActions } from './NavigationActions';
import { toast } from '@src/hooks/use-toast';

export interface DockNavigationAction {
  icon: LucideIcon;
  name: string;
  // Either a sync dock pointer OR an async action callback (not both)
  dockPointer?: (result: SearchResult) => DockPointer;
  action?: (result: SearchResult, navigation: NavigationActions) => void | Promise<void>;
}

export interface RecordTypeNav {
  /** Sync primary click — produces a DockPointer directly */
  dockPointer?: (result: SearchResult) => DockPointer | null;
  /** Async primary click — use when navigation requires entity lookup */
  primaryAction?: (result: SearchResult, navigation: NavigationActions) => void | Promise<void>;
  /** Optional sub-navigation chips shown on the card */
  actions?: DockNavigationAction[];
}

/** Extract the Claude session UUID from a search result */
function sessionIdFromResult(result: SearchResult): string {
  // asset_ref: "/path/to/<uuid>.jsonl" — derive session UUID from filename
  if (result.asset_ref) {
    const filename = result.asset_ref.split('/').pop() ?? '';
    const id = filename.replace(/\.jsonl$/i, '');
    if (id) return id;
  }
  // Fallback: record_id TypeId format "claude_session-<uuid>"
  return result.record_id.replace(/^claude_session-/, '');
}

/** Extract the Codex thread_id from a rollout asset_ref or record_id.
 *
 * Codex rollouts are named ``rollout-<ISO-ts>-<thread_id>.jsonl`` — the
 * thread_id is the last 5 hyphen-separated groups of the stem. We mirror the
 * backend ``_extract_thread_id`` helper here so the UI doesn't need to round-trip.
 */
function codexThreadIdFromResult(result: SearchResult): string {
  if (result.asset_ref) {
    const stem = (result.asset_ref.split('/').pop() ?? '').replace(/\.jsonl$/i, '');
    if (stem.startsWith('rollout-')) {
      const parts = stem.slice('rollout-'.length).split('-');
      if (parts.length >= 5) return parts.slice(-5).join('-');
    }
  }
  // Fallback: record_id is the thread_id directly (set by CodexSessionRecord.getId).
  return result.record_id.replace(/^codex_session-/, '');
}

/** Extract the project encoded name from a session search result's asset_ref */
function projectEncodedNameFromResult(result: SearchResult): string {
  // asset_ref: "/.../.claude/projects/<project_encoded>/<uuid>.jsonl"
  const parts = result.asset_ref.split('/');
  parts.pop(); // remove filename
  return parts.pop() ?? '';
}


export const RECORD_TYPE_NAV: Partial<Record<string, RecordTypeNav>> = {
  skill: {
    dockPointer: (r) => new Skill({ id: r.record_id, asset_ref: r.asset_ref || undefined }).searchDockPointer,
    actions: [
      { icon: Search, name: 'All skills', dockPointer: () => DockPointer.forSearch(undefined, { record_type: 'skill' }) },
    ],
  },
  claude_hook: {
    dockPointer: (r) => new DockPointer(ViewType.HOOKS, undefined, {
      hookId: r.record_id,
    }),
    actions: [
      { icon: Search, name: 'All hooks', dockPointer: () => DockPointer.forSearch(undefined, { record_type: 'claude_hook' }) },
    ],
  },
  agent: {
    dockPointer: (r) => {
      const agent = new Agent({ id: r.record_id, name: r.name || undefined, asset_ref: r.asset_ref || undefined });
      return agent.searchDockPointer;
    },
  },
  annotation: {
    primaryAction: async (r, navigation) => {
      const sessionId = r.session_id;
      if (sessionId) {
        const p = await navigation.openWorkerSession(sessionId);
        if (!p) toast({ title: 'Session not found', description: `Session ${sessionId} is not in Claude or Codex history.`, variant: 'destructive' });
      }
    },
  },
  bookmark: {
    primaryAction: async (r, navigation) => {
      const sessionId = r.session_id;
      if (sessionId) {
        const p = await AgenticProcess.getByWorkerId(sessionId);
        if (!p) {
          toast({ title: 'Session not found', description: `Session ${sessionId} is not in Claude or Codex history.`, variant: 'destructive' });
          return;
        }
        navigation.openDockPointer(p.dockPointer, r.created_at ? { t: r.created_at } : undefined);
      }
    },
  },
  command: {
    dockPointer: (r) => r.asset_ref
      ? new DockPointer(ViewType.ASSETS, `editor/command/${r.asset_ref.replace(/^\//, '')}`)
      : null,
  },
  comment: {
    primaryAction: async (r, navigation) => {
      const sessionId = r.session_id;
      if (sessionId) {
        const p = await navigation.openWorkerSession(sessionId);
        if (!p) toast({ title: 'Session not found', description: `Session ${sessionId} is not in Claude or Codex history.`, variant: 'destructive' });
      }
    },
  },
  [RecordType.MARKDOWN]: {
    dockPointer: (r) => r.asset_ref
      ? new DockPointer(ViewType.ASSETS, `editor/${RecordType.MARKDOWN}/${r.asset_ref.replace(/^\//, '')}`)
      : null,
  },
  plan: {
    dockPointer: (r) => r.asset_ref
      ? new DockPointer(ViewType.ASSETS, `editor/plan/${r.asset_ref.replace(/^\//, '')}`)
      : null,
  },
  workflow: {
    dockPointer: (r) => r.asset_ref
      ? new DockPointer(ViewType.ASSETS, `editor/workflow/${r.asset_ref.replace(/^\//, '')}`)
      : null,
  },
  claude_md: {
    dockPointer: (r) => r.asset_ref
      ? new DockPointer(ViewType.ASSETS, `editor/claude_md/${r.asset_ref.replace(/^\//, '')}`)
      : null,
  },
  claude_memory: {
    dockPointer: (r) => r.asset_ref
      ? new DockPointer(ViewType.ASSETS, `editor/claude_memory/${r.asset_ref.replace(/^\//, '')}`)
      : null,
  },
  claude_rules: {
    dockPointer: (r) => r.asset_ref
      ? new DockPointer(ViewType.ASSETS, `editor/claude_rules/${r.asset_ref.replace(/^\//, '')}`)
      : null,
  },
  claude_settings: {
    dockPointer: () => DockPointer.forSettings(),
  },
  claude_settings_json: {
    dockPointer: () => DockPointer.forSettings(),
  },
  task: {
    dockPointer: (r) => new Task({ id: r.record_id }).searchDockPointer,
    actions: [
      { icon: CheckSquare, name: 'All tasks', dockPointer: () => DockPointer.forTasks() },
    ],
  },
  agentic_process: {
    dockPointer: (r) => new AgenticProcess({
      id: r.record_id,
      session_id: (r as any).session_id ?? undefined,
      project_encoded_name: (r as any).project_encoded_name ?? undefined,
    }).searchDockPointer,
  },
  project: {
    dockPointer: (r) => new Project({ id: r.record_id }).searchDockPointer,
  },
  codex_session: {
    primaryAction: async (r, navigation) => {
      const threadId = codexThreadIdFromResult(r);
      const p = await AgenticProcess.getByWorkerId(threadId);
      if (!p) {
        toast({ title: 'Session not found', description: `Session ${threadId} is not in Claude or Codex history.`, variant: 'destructive' });
        return;
      }
      navigation.openDock(p.dockPointer);
    },
    actions: [
      {
        icon: FileText,
        name: 'Transcript',
        action: (r, navigation) => {
          // codex/transcript lens (LensViewer.tsx case 'codex/transcript')
          // expects URL-encoded absolute path. DockPointer.forLensTranscript
          // applies the encoding when workerType === 'codex'.
          if (r.asset_ref) navigation.openDock(DockPointer.forLensTranscript('codex', r.asset_ref));
        },
      },
    ],
  },
  claude_session: {
    primaryAction: async (r, navigation) => {
      const sessionId = sessionIdFromResult(r);
      const p = await AgenticProcess.getByWorkerId(sessionId);
      if (!p) {
        toast({ title: 'Session not found', description: `Session ${sessionId} is not in Claude or Codex history.`, variant: 'destructive' });
        return;
      }
      navigation.openDock(p.dockPointer);
    },
    actions: [
      {
        icon: FileText,
        name: 'Transcript',
        action: (r, navigation) => {
          const sessionId = sessionIdFromResult(r);
          const projectEncodedName = projectEncodedNameFromResult(r);
          navigation.openLens('claude', 'transcript', `${projectEncodedName}/${sessionId}`);
        },
      },
      {
        icon: GitBranch,
        name: 'Fork',
        action: async (r, navigation) => {
          const sessionId = sessionIdFromResult(r);
          const record = await ClaudeSessionRecord.discover(sessionId).catch(() => null);
          const cwd = record?.cwd ?? undefined;
          const computeNode = dataContext.computeNode;
          if (!computeNode) throw new Error('[Fork] No compute node');
          const p = await computeNode.createProcess(
            cwd ? { workdir: cwd } : {},
            { visible: true, watchProcess: false },
          );
          void navigation.openShellProcess(p.id);
        },
      },
    ],
  },
};

/** Returns the primary DockPointer for a result, or null if the type has no navigation */
export function getDockPointerForResult(result: SearchResult): DockPointer | null {
  return RECORD_TYPE_NAV[result.record_type]?.dockPointer?.(result) ?? null;
}

/** Returns true if the result type has any primary navigation (sync or async) */
export function isResultNavigable(result: SearchResult): boolean {
  const nav = RECORD_TYPE_NAV[result.record_type];
  return !!(nav?.dockPointer || nav?.primaryAction);
}

/** Navigate to a result — handles both sync dockPointer and async primaryAction */
export async function navigateToResult(result: SearchResult, navigation: NavigationActions): Promise<void> {
  const nav = RECORD_TYPE_NAV[result.record_type];
  if (!nav) return;
  if (nav.primaryAction) {
    await nav.primaryAction(result, navigation);
  } else if (nav.dockPointer) {
    const dp = nav.dockPointer(result);
    if (dp) navigation.openDock(dp);
  }
}

/** Returns the action list for a result's record type */
export function getActionsForResult(result: SearchResult): DockNavigationAction[] {
  return RECORD_TYPE_NAV[result.record_type]?.actions ?? [];
}
