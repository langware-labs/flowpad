import { AgenticProcess, dataContext, dataManager, Shell, Tab, TypeId } from '@sdk';
import type { DockPointer } from '@src/navigation/DockPointer';
import { providerKindForWorkerType } from '@src/tabs/provider-kind';

/**
 * Resolved display primitives for a terminal target, read from the entity the
 * route loader just hydrated into cache. Stamped onto the Tab at creation so the
 * strip draws the chip (provider icon + worktree badge) without ever fetching
 * the backing Shell/AgenticProcess. Static per tab — worker_type/worktree don't
 * change over a tab's life — so these are CREATE-only (see Tab.ensureFor).
 *
 * ``icon`` mirrors the strip's PROVIDER_META keys exactly: a shell target is
 * `'shell'`; a process is keyed by its lower-cased worker_type
 * (`'codex'`/`'copilot'`), defaulting to `'claude'`.
 */
function terminalDisplayForTarget(
  targetType: string | null,
  targetId: string | null,
): { icon: string | null; worktree: boolean } {
  if (!targetType || !targetId) return { icon: null, worktree: false };
  if (targetType === Shell.type) return { icon: 'shell', worktree: false };
  if (targetType === AgenticProcess.type) {
    const process = AgenticProcess.getByIdFromCache<AgenticProcess>(targetId);
    return {
      icon: providerKindForWorkerType(process?.worker_type),
      worktree: Boolean(process?.cliOptions?.worktree),
    };
  }
  return { icon: null, worktree: false };
}

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
    // Two shapes carry an entity: the type lives IN the pointer (`<type>-<id>`
    // / `…/typeid/<type>-<id>`), or — for a bare-id pointer — in the dock's
    // viewType segment (e.g. /dock/conversation/<uuid>). Try the pointer first,
    // then fold viewType + pointer. Both reject (target-less) on non-entities.
    const tryTypeId = (type: string, id?: string): TypeId | null => {
      try {
        return id !== undefined ? new TypeId(type, id) : new TypeId(type);
      } catch {
        return null;
      }
    };
    const tid =
      tryTypeId(candidate) ?? (dock.viewType && !pointer.includes('/') ? tryTypeId(dock.viewType, pointer) : null);
    if (tid) return { targetType: tid.type, targetId: tid.id };
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
  const { icon, worktree } = terminalDisplayForTarget(targetType, targetId);
  void Tab.ensureFor(pointerHash, {
    targetType,
    targetId,
    projectId: dataContext.project?.id ?? null,
    // Distinguished initial name — set ONCE at creation (ensureFor ignores it on
    // reuse, preserving any rename). entity name / vfs basename / wiki keyword.
    name: dataManager.getTabName(dock),
    // Display primitives stamped at creation from the loader-hydrated entity so
    // the strip renders the chip without fetching the Shell/AgenticProcess.
    iconKey: icon,
    worktree,
  })
    .then((tab) => tab.activate())
    .catch(() => {
      /* tab materialization is best-effort; never block or fail navigation */
    });
}
