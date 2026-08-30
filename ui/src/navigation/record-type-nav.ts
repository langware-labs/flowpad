import { t } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { LucideIcon } from 'lucide-react';
import type { SearchResult } from '@src/hooks/use-record-search';
import { DockPointer } from './DockPointer';
import { openNewChat } from './open-new-chat';
import { ViewType } from '@src/types/ViewType';
import { CheckSquare, Search, GitBranch, FileText } from 'lucide-react';
import { AgenticProcess, Artifact, dataContext, dataManager, editorForType, isTypeId, RecordType, TypeId } from '@sdk';
import { ClaudeSessionRecord } from '@sdk/resource_management/fs_records/claude/claude-session.js';
import type { NavigationActions } from './NavigationActions';
import { openArtifact } from '@src/components/artifacts/open-artifact';
import { notify } from '@src/notifications';

/**
 * An action as AUTHORED in the RECORD_TYPE_NAV table: `name` is a lazy lingui
 * descriptor, because the table is module-level and an eager macro would bind
 * the language at import time and never follow a locale switch.
 */
export interface DockNavigationActionSpec {
  icon: LucideIcon;
  name: MessageDescriptor;
  // Either a sync dock pointer OR an async action callback (not both)
  dockPointer?: (result: SearchResult) => DockPointer;
  action?: (result: SearchResult, navigation: NavigationActions) => void | Promise<void>;
}

/**
 * An action as HANDED TO CONSUMERS by `getActionsForResult`, which resolves the
 * descriptor. `name` is a plain string here, which is what the renderers put in
 * the DOM — declaring it as the descriptor made every consumer a type error.
 */
export interface DockNavigationAction extends Omit<DockNavigationActionSpec, 'name'> {
  name: string;
}

export interface RecordTypeNav {
  /** Sync primary click — produces a DockPointer directly */
  dockPointer?: (result: SearchResult) => DockPointer | null;
  /** Async primary click — use when navigation requires entity lookup */
  primaryAction?: (result: SearchResult, navigation: NavigationActions) => void | Promise<void>;
  /** Extra reachability check for imperative arms whose target fields are optional. */
  isNavigable?: (result: SearchResult) => boolean;
  /** Optional sub-navigation chips shown on the card */
  actions?: DockNavigationActionSpec[];
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

/**
 * The stable TypeId for a search result, or null when no usable id is present.
 * ``record_id`` may be a full ``<type>-<uuid>`` typeid (favorites store the full
 * form) or a bare uuid (search rows) — handle both.
 */
export function resultTypeId(
  // Structural: accepts any search-row shape (use-record-search / use-asset-search)
  // — only the stable id + type are read.
  r: { record_id?: string | null; record_type?: string | null },
): TypeId | null {
  const raw = (r.record_id ?? '').trim();
  if (!raw) return null;
  try {
    if (isTypeId(raw)) return new TypeId(raw);
    if (r.record_type) return new TypeId(r.record_type, raw);
  } catch {
    /* fall through to null */
  }
  return null;
}

/**
 * Pointer for an entity-backed asset, preferring the stable TypeId over the
 * absolute ``asset_ref`` path. TypeId routing (``editor/<editor>/typeid/<id>``)
 * resolves by id with no path discovery — relocation-proof and instant. Falls
 * back to the vfs/path form only when no usable id is present.
 */
function assetEditorPointer(assetType: string, r: SearchResult): DockPointer | null {
  const tid = resultTypeId(r);
  if (tid) return DockPointer.forAssetEditorByTypeId(assetType, tid);
  return r.asset_ref ? DockPointer.forAssetEditor(assetType, r.asset_ref) : null;
}

/** Registry-backed fallback for entity types with an asset editor. Explicit
 * navigation arms below still win; this keeps new editable asset types from
 * becoming inert search/recent-activity rows just because this dispatcher was
 * not updated in lockstep with the editor registry. */
function registeredAssetPointer(result: SearchResult): DockPointer | null {
  return editorForType(result.record_type)
    ? assetEditorPointer(result.record_type, result)
    : null;
}

export const RECORD_TYPE_NAV: Partial<Record<string, RecordTypeNav>> = {
  skill: {
    dockPointer: (r) => assetEditorPointer('skill', r),
    actions: [
      {
        icon: Search,
        name: msg`All skills`,
        dockPointer: () => DockPointer.forSearch(undefined, { record_type: 'skill' }),
      },
    ],
  },
  claude_hook: {
    dockPointer: (r) =>
      new DockPointer(ViewType.HOOKS, undefined, {
        hookId: r.record_id,
      }),
    actions: [
      {
        icon: Search,
        name: msg`All hooks`,
        dockPointer: () => DockPointer.forSearch(undefined, { record_type: 'claude_hook' }),
      },
    ],
  },
  agent: {
    dockPointer: (r) => assetEditorPointer('agent', r),
  },
  annotation: {
    isNavigable: (r) => !!r.session_id,
    primaryAction: async (r, navigation) => {
      const sessionId = r.session_id;
      if (sessionId) {
        const p = await navigation.openWorkerSession(sessionId);
        if (!p)
          notify.error({
            title: t`Session not found`,
            message: t`Session ${sessionId} is not in Claude, Codex, or Copilot history.`,
          });
      }
    },
  },
  bookmark: {
    isNavigable: (r) => !!r.session_id,
    primaryAction: async (r, navigation) => {
      const sessionId = r.session_id;
      if (sessionId) {
        const p = await AgenticProcess.getByWorkerId(sessionId);
        if (!p) {
          notify.error({
            title: t`Session not found`,
            message: t`Session ${sessionId} is not in Claude, Codex, or Copilot history.`,
          });
          return;
        }
        navigation.openDockPointer(p.dockPointer, r.created_at ? { t: r.created_at } : undefined);
      }
    },
  },
  command: {
    dockPointer: (r) => assetEditorPointer('command', r),
  },
  comment: {
    isNavigable: (r) => !!r.session_id,
    primaryAction: async (r, navigation) => {
      const sessionId = r.session_id;
      if (sessionId) {
        const p = await navigation.openWorkerSession(sessionId);
        if (!p)
          notify.error({
            title: t`Session not found`,
            message: t`Session ${sessionId} is not in Claude, Codex, or Copilot history.`,
          });
      }
    },
  },
  [RecordType.MARKDOWN]: {
    dockPointer: (r) => assetEditorPointer(RecordType.MARKDOWN, r),
  },
  graph_workflow: {
    dockPointer: (r) => {
      const tid = resultTypeId(r);
      return tid ? DockPointer.forGraphWorkflow(tid.id) : null;
    },
  },
  graph_context: {
    dockPointer: (r) => {
      const tid = resultTypeId(r);
      return tid ? DockPointer.forGraphContext(tid.id) : null;
    },
  },
  trigger: {
    dockPointer: (r) => {
      const tid = resultTypeId(r);
      return tid ? DockPointer.forEvents(tid.id) : null;
    },
  },
  conversation: {
    dockPointer: (r) => {
      const tid = resultTypeId(r);
      return tid ? DockPointer.forConversation(tid.id) : null;
    },
  },
  spec: {
    dockPointer: (r) => {
      const tid = resultTypeId(r);
      return tid ? DockPointer.forSpec(tid.id) : null;
    },
  },
  plan: {
    dockPointer: (r) => assetEditorPointer('plan', r),
  },
  claude_md: {
    dockPointer: (r) => assetEditorPointer('claude_md', r),
  },
  claude_memory: {
    dockPointer: (r) => assetEditorPointer('claude_memory', r),
  },
  claude_rules: {
    dockPointer: (r) => assetEditorPointer('claude_rules', r),
  },
  claude_settings: {
    dockPointer: () => DockPointer.forSettings(),
  },
  claude_settings_json: {
    dockPointer: () => DockPointer.forSettings(),
  },
  task: {
    dockPointer: (r) => {
      const tid = resultTypeId(r);
      return tid ? DockPointer.forTasks(tid.id) : null;
    },
    actions: [{ icon: CheckSquare, name: msg`All tasks`, dockPointer: () => DockPointer.forTasks() }],
  },
  agentic_process: {
    dockPointer: (r) => {
      const tid = resultTypeId(r);
      if (!tid) return null;
      // Prefer the live cached process — its searchDockPointer carries the real
      // worker_type. Never construct a throwaway `new AgenticProcess` here: the
      // APIEntity constructor registers itself into the FlowSync store and would
      // overwrite the cached process with a near-empty stub (store.ts warning
      // "already registered with different entity"). Fall back to a
      // construction-free pointer when the process isn't cached.
      const cached = dataManager.getByTypeIdFromCache<AgenticProcess>(tid);
      // `searchDockPointer` is the SDK's plain `DockPointerData`; this table hands
      // back the UI class, so re-seat its three fields rather than leaking the
      // interface up through `Browseable.pointer`.
      if (cached) {
        const dp = cached.searchDockPointer;
        return new DockPointer(dp.viewType, dp.pointer, dp.options);
      }
      const sessionId = (r as any).session_id ?? undefined;
      return sessionId
        ? DockPointer.forLensTranscript('claude', sessionId)
        : new DockPointer(ViewType.SHELL, `${AgenticProcess.type}${TypeId.DELIMITER}${tid.id}`);
    },
  },
  project: {
    dockPointer: (r) => {
      const tid = resultTypeId(r);
      return tid ? new DockPointer(ViewType.ASSETS, 'list/all', { scope: 'project', project_ids: tid.id }) : null;
    },
  },
  artifact: {
    // A vibe artifact (webapp) is a graph entity, not an asset-editor doc — an
    // asset-editor dock would bypass the real open path. Route through
    // ``openArtifact`` so a git-backed app resolves its checkout (git-setup
    // wizard → clone) and launches in a Vibe process, exactly like the artifact
    // card. Imperative arm: needs the full Artifact entity, not just the row.
    primaryAction: async (r, navigation) => {
      const tid = resultTypeId(r);
      if (!tid) return;
      const artifact = await dataManager.getByTypeId<Artifact>(new TypeId(Artifact.type, tid.id)).catch(() => null);
      if (!artifact) {
        notify.error({ title: t`App not found`, message: t`This app is no longer available.` });
        return;
      }
      openArtifact(artifact, {
        navigation,
        currentProjectId: dataContext.project?.id ?? null,
      });
    },
  },
  codex_session: {
    primaryAction: async (r, navigation) => {
      const threadId = codexThreadIdFromResult(r);
      const p = await AgenticProcess.getByWorkerId(threadId);
      if (!p) {
        notify.error({
          title: t`Session not found`,
          message: t`Session ${threadId} is not in Claude, Codex, or Copilot history.`,
        });
        return;
      }
      navigation.openDock(p.dockPointer);
    },
    actions: [
      {
        icon: FileText,
        name: msg`Transcript`,
        action: (r, navigation) => {
          // codex/transcript lens (LensViewer.tsx case 'codex/transcript')
          // expects URL-encoded absolute path. DockPointer.forLensTranscript
          // applies the encoding when workerType === 'codex'.
          if (r.asset_ref) navigation.openDock(DockPointer.forLensTranscript('codex', r.asset_ref));
        },
      },
    ],
  },
  copilot_session: {
    primaryAction: async (r, navigation) => {
      const sessionId = r.record_id.replace(/^copilot_session-/, '');
      const p = await AgenticProcess.getByWorkerId(sessionId);
      if (!p) {
        notify.error({
          title: t`Session not found`,
          message: t`Session ${sessionId} is not in Claude, Codex, or Copilot history.`,
        });
        return;
      }
      navigation.openDock(p.dockPointer);
    },
    actions: [
      {
        icon: FileText,
        name: msg`Transcript`,
        action: (r, navigation) => {
          if (r.asset_ref) navigation.openDock(DockPointer.forLensTranscript('copilot', r.asset_ref));
        },
      },
    ],
  },
  claude_session: {
    primaryAction: async (r, navigation) => {
      const sessionId = sessionIdFromResult(r);
      const p = await AgenticProcess.getByWorkerId(sessionId);
      if (!p) {
        notify.error({
          title: t`Session not found`,
          message: t`Session ${sessionId} is not in Claude, Codex, or Copilot history.`,
        });
        return;
      }
      navigation.openDock(p.dockPointer);
    },
    actions: [
      {
        icon: FileText,
        name: msg`Transcript`,
        action: (r, navigation) => {
          navigation.openLens('claude', 'transcript', sessionIdFromResult(r));
        },
      },
      {
        icon: GitBranch,
        name: msg`Fork`,
        action: async (r, navigation) => {
          const sessionId = sessionIdFromResult(r);
          const record = await ClaudeSessionRecord.discover(sessionId).catch(() => null);
          const cwd = record?.cwd ?? undefined;
          // Forking starts a new chat, so it opens in the user's chat mode.
          void openNewChat(navigation, cwd ? { cwd } : {});
        },
      },
    ],
  },
  workflow_run: {
    // A workflow run has no AgenticProcess — its asset_ref IS the provider
    // journal, served as a "workflow" transcript by absolute path.
    primaryAction: (r, navigation) => {
      if (r.asset_ref) navigation.openDock(DockPointer.forLensTranscript('workflow', r.asset_ref));
    },
    actions: [
      {
        icon: FileText,
        name: msg`Transcript`,
        action: (r, navigation) => {
          if (r.asset_ref) navigation.openDock(DockPointer.forLensTranscript('workflow', r.asset_ref));
        },
      },
    ],
  },
};

/** Returns the primary DockPointer for a result, or null if the type has no navigation */
export function getDockPointerForResult(result: SearchResult): DockPointer | null {
  return RECORD_TYPE_NAV[result.record_type]?.dockPointer?.(result)
    ?? registeredAssetPointer(result);
}

/** Returns true if the result actually has a reachable target — not merely that
 * its type declares a navigation handler. A `dockPointer` that would resolve to
 * `null` (e.g. an asset with neither a typeid nor an asset_ref) is NOT navigable;
 * treating it as navigable is what made tiles look clickable yet do nothing. */
export function isResultNavigable(result: SearchResult): boolean {
  const nav = RECORD_TYPE_NAV[result.record_type];
  if (nav?.isNavigable && !nav.isNavigable(result)) return false;
  if (nav?.primaryAction) return true;
  if (nav?.dockPointer?.(result)) return true;
  return registeredAssetPointer(result) != null;
}

/** Navigate to a result — handles both sync dockPointer and async primaryAction */
export async function navigateToResult(result: SearchResult, navigation: NavigationActions): Promise<void> {
  const nav = RECORD_TYPE_NAV[result.record_type];
  if (nav?.isNavigable && !nav.isNavigable(result)) return;
  if (nav?.primaryAction) {
    await nav.primaryAction(result, navigation);
    return;
  }
  const dock = nav?.dockPointer?.(result) ?? registeredAssetPointer(result);
  if (dock) navigation.openDock(dock);
}

/** Returns the action list for a result's record type */
export function getActionsForResult(result: SearchResult): DockNavigationAction[] {
  // Resolved HERE, at the one accessor, so `DockNavigationAction.name` stays a
  // plain string for every consumer while the table itself holds lazy
  // descriptors (it is module-level, so an eager macro would bind the language
  // at import and never follow a locale switch).
  return (RECORD_TYPE_NAV[result.record_type]?.actions ?? []).map((action) => ({
    ...action,
    name: i18n._(action.name),
  }));
}
