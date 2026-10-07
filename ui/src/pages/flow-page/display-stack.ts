import type { ShowTarget } from '@sdk';
import type { DisplayEntry } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {dockForDisplayTarget} from '@src/navigation/display-target-pointer';


/** Every field that tells one display target from another — mirrors the backend's
 *  `DISPLAY_TARGET_KEYS` (flow_sdk/builtin/agentic_process/display_context.py), so
 *  the client never merges two shows the server keeps apart, or the reverse. */
const DISPLAY_TARGET_KEYS = [
  'kind',
  'typeid',
  'type',
  'id',
  'path',
  'port',
  'view_type',
  'pointer',
  'page',
  'options',
  'url',
  'artifact_id',
] as const;

/** What a display target addresses — equal for two shows of the same thing,
 *  whatever their `shown_at` or source location. */
function targetKey(target: ShowTarget): string {
  const fields = target as Record<string, unknown>;
  return JSON.stringify(DISPLAY_TARGET_KEYS.map((k) => fields[k] ?? null));
}

/** Do two display targets address the same thing? */
function sameDisplayTarget(a: ShowTarget, b: ShowTarget): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * One entry per target, newest first — each the LATEST show of it. Takes the
 * stack as stored (oldest first). The server already keeps one entry per target;
 * this tidies stacks persisted before it did.
 */
export function latestPerTarget(stack: readonly DisplayEntry[]): DisplayEntry[] {
  const seen = new Set<string>();
  const rows: DisplayEntry[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const key = targetKey(stack[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(stack[i]);
  }
  return rows;
}

/**
 * The history to render: the server's stack, plus the newest show if that stack
 * has not caught up with it yet.
 *
 * The stack is server-owned and authoritative, but it reaches the client on the
 * entity-update broadcast — and a `flow show` NAVIGATES, so that broadcast can land
 * while the route is tearing down and rebuilding the workspace's subscription,
 * leaving the cached entity one entry behind until something re-reads it. The event
 * that drove the navigation carries the very entry that went missing.
 *
 * Deliberately bounded to ONE entry, appended only when the server's own newest
 * differs. The next authoritative read supersedes it, so this can never grow into a
 * parallel history that drifts from the server's `shown_at` ordering — which is the
 * failure mode a hand-maintained local mirror has.
 */
export function displayHistory(
  serverStack: readonly DisplayEntry[],
  latestShown: ShowTarget | null | undefined,
): readonly DisplayEntry[] {
  if (!latestShown) return serverStack;
  const newest = serverStack[serverStack.length - 1];
  if (newest && sameDisplayTarget(newest, latestShown)) return serverStack;
  return [...serverStack, latestShown as DisplayEntry];
}

/**
 * Where a history-popover row opens: the target's own address, WITHOUT the
 * active-display marker.
 *
 * That omission is the whole behavior — no marker means ordinary tab identity, so
 * the row becomes a durable tab the user owns instead of re-pointing the agent's
 * replaceable one. The project rebase is the usual scope-keyed guard: a bare ASSETS
 * dock folds every sub-pointer of a scope into one tab, so an un-rebased document
 * would hijack that scope's Assets tab rather than getting an identity of its own.
 *
 * Null when the entry addresses nothing openable (an entity type with no editor and
 * no path) — a real answer; the caller does nothing and the entry stays in history.
 */
export function historyEntryDock(entry: ShowTarget, projectId: string | null): DockPointer | null {
  const dock = dockForDisplayTarget(entry);
  return dock ? DockPointer.rebaseAssetsOntoProject(dock, projectId) : null;
}

/**
 * The project a workspace-hosted dock is rebased onto, or null.
 *
 * Through `splitProjectPointer`, which owns that grammar (and its host-lift
 * tripwire), and gated on the dock actually being a PROJECT dock — a raw
 * `pointer.split('/')[0]` answers `"editor"` for an editor dock and would feed
 * that to `rebaseAssetsOntoProject` as if it were a project id.
 */
export function projectIdFromDock(dock: DockPointer | null): string | null {
  if (dock?.viewType !== ViewType.PROJECT) return null;
  return DockPointer.splitProjectPointer(dock.pointer).projectId;
}
