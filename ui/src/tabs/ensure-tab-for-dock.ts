import { AgenticProcess, dataContext, dataManager, Shell, Tab, TypeId } from '@sdk';
import type { DockPointer } from '@src/navigation/DockPointer';
import { providerKindForWorkerType } from '@src/tabs/provider-kind';
import { applyRows } from '@src/tabs/tab-store';

/**
 * Resolved display primitives for a terminal target, read from the entity the
 * route loader just hydrated into cache. Stamped onto the Tab at creation so the
 * strip draws the chip (provider icon + worktree badge) without ever fetching
 * the backing Shell/AgenticProcess. Static per tab — worker_type/worktree don't
 * change over a tab's life — so these are CREATE-only (see Tab.newTab).
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
  const projectId = dataContext.project?.id ?? null;
  // Backend-owned create: get-or-create + place in the global order (a fresh tab
  // lands right after the opener = the most-recently-active tab; reopen keeps its
  // slot). Returns the canonical ordered list → adopt it as the render source.
  // No `afterTabId` here: the backend resolves the opener from recency, so the
  // URL-first click path stays "navigate only".
  void Tab.newTab(pointerHash, {
    targetType,
    targetId,
    projectId,
    name: dataManager.getTabName(dock),
    iconKey: icon,
    worktree,
  })
    .then((rows) => {
      applyRows(rows, projectId);
      // Stamp recency so the NEXT open treats THIS tab as the opener.
      const created = rows.find((r) => r.pointer === pointerHash);
      if (created) void Tab.activateById(created.id);
    })
    .catch(() => {
      /* tab materialization is best-effort; never block or fail navigation */
    });
}
