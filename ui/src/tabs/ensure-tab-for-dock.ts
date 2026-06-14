import { dataContext, dataManager, Tab, TypeId } from '@sdk';
import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * Best-effort denormalized target identity for a dock — the entity this tab
 * "shows", stored on the Tab for fast reverse lookup (close-on-target-delete)
 * and for the strip to resolve the live entity (status/PTY/name).
 *
 * Two shapes resolve a target: a pointer that IS a canonical TypeId string
 * (``shell-<id>`` / ``agentic_process-<id>`` — the terminal surfaces), and the
 * asset-editor ``…/typeid/<type>-<uuid>`` form. Everything else is target-less
 * (settings, search, diff, home) and rides as a transient-but-persistent tab.
 */
export function targetForDock(dock: DockPointer): { targetType: string | null; targetId: string | null } {
  const pointer = dock.pointer;
  if (pointer) {
    const candidate = pointer.includes('/typeid/') ? pointer.split('/typeid/').pop() ?? '' : pointer;
    try {
      const tid = new TypeId(candidate);
      return { targetType: tid.type, targetId: tid.id };
    } catch {
      /* not a typeid-bearing pointer — target-less surface */
    }
  }
  return { targetType: null, targetId: null };
}

/**
 * URL-first tab materialization (docs/tab-management.md): the route loader — the
 * single writer — ensures a Tab exists for the dock the URL just landed on and
 * stamps its recency. Fire-and-forget so the loader stays fast; the click path
 * only ``navigation.openDock(...)``, never this. Every dock view funnels here,
 * so terminals, docs, assets, settings and diffs all become tabs by one rule.
 */
export function ensureTabForCurrentDock(dock: DockPointer): void {
  if (!dock.viewType) return;
  const pointerHash = dock.tabHash;
  if (!pointerHash.trim()) return;
  const { targetType, targetId } = targetForDock(dock);
  void Tab.ensureFor(pointerHash, {
    targetType,
    targetId,
    projectId: dataContext.project?.id ?? null,
    // Distinguished initial name — set ONCE at creation (ensureFor ignores it on
    // reuse, preserving any rename). entity name / vfs basename / wiki keyword.
    name: dataManager.getTabName(dock),
  })
    .then((tab) => tab.activate())
    .catch(() => {
      /* tab materialization is best-effort; never block or fail navigation */
    });
}
