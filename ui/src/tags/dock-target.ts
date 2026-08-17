import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * THE dock identity used on the bus — the route emitter stamps it as the
 * `app.route.loaded` target, and journey route-awaits resolve their authored
 * dock through this same function. One producer, one consumer, one string —
 * any drift here makes route awaits silently never match.
 */
export function dockTarget(dock: Pick<DockPointer, 'viewType' | 'pointer' | 'isRoot'> | null): string {
  // The root keeps the identity a null dock emitted before the root became a
  // real pointer: `dock:home`, NOT `dock:home/`.
  //
  // Only the root is special-cased. A pointer-less dock keeps its trailing
  // slash (`dock:explorer/`) because the subscription grammar is a prefix glob:
  // `dock:shell/*` matches `dock:shell/` and not `dock:shell`, so "tidying" the
  // slash away would silently unmatch every other view's route subscriptions.
  if (!dock || dock.isRoot) return 'dock:home';
  return `dock:${dock.viewType}/${dock.pointer ?? ''}`;
}
