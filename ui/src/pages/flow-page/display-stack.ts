import type { DisplayEntry } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import type { DisplayShowTarget } from './display-annotation';

/** Do two display targets address the same thing? (Kind plus whichever key that kind uses.) */
function sameDisplayTarget(a: DisplayShowTarget, b: DisplayShowTarget): boolean {
  return (
    a.kind === b.kind &&
    (a.typeid ?? null) === (b.typeid ?? null) &&
    (a.path ?? null) === (b.path ?? null) &&
    (a.port ?? null) === (b.port ?? null) &&
    (a.artifact_id ?? null) === (b.artifact_id ?? null)
  );
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
  latestShown: DisplayShowTarget | null | undefined,
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
export function historyEntryDock(entry: DisplayShowTarget, projectId: string | null): DockPointer | null {
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
