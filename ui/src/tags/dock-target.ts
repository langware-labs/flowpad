import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * THE dock identity used on the bus — the route emitter stamps it as the
 * `app.route.loaded` target, and journey route-awaits resolve their authored
 * dock through this same function. One producer, one consumer, one string —
 * any drift here makes route awaits silently never match.
 */
export function dockTarget(dock: Pick<DockPointer, 'viewType' | 'pointer'> | null): string {
  if (!dock) return 'dock:home';
  return `dock:${dock.viewType}/${dock.pointer ?? ''}`;
}
