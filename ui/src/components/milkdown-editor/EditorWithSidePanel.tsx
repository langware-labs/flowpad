import { t } from '@lingui/core/macro';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { Link2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useIsAdvanced } from '@src/components/view-mode';
import { TabbedSideDrawer, type TabDescriptor } from '@src/components/ui/side-drawer';
import { CollapsedSideRail, SideRailButton } from '@src/components/ui/collapsed-side-rail';
import { useSideWindows } from '@src/navigation/useSideWindows';
import { BacklinksTab } from './side-windows';

// The one built-in side window; asset editors append extras via `extraTabs`.
const BACKLINKS_TAB: TabDescriptor = {
  id: 'backlinks',
  label: t`Backlinks`,
  icon: Link2,
  description: t`Documents that link here`,
};

// Vibe/Standard keep the markdown rail deliberately small. Context is supplied
// only by surfaces that support it; Revisions is supplied by MarkdownEditor.
// Translations is a first-class doc affordance (read a doc in another language),
// so it stays available in every mode. Everything else (Backlinks and other
// asset-specific tools such as Runs/Eval) is a power-user option and remains
// available in Advanced/Dev only.
// Built-in tabs that stay available in Vibe/Standard. Caller-injected extras
// declare their own non-Advanced visibility via `ExtraSideTab.availableInNonAdvanced`
// (mode-visibility is a property of the tab, not a registry the shell owns).
const NON_ADVANCED_SIDE_TAB_IDS = new Set(['context', 'revisions']);

/**
 * Extra tab a caller can inject alongside Backlinks. The `panel` is the
 * ReactNode rendered when the tab is active. Used by asset types (workflow
 * Runs, revisions, …) to append a window without forking this component.
 */
export interface ExtraSideTab {
  id: string;
  label: string;
  icon: TabDescriptor['icon'];
  description?: string;
  panel: ReactNode;
  /**
   * Keep this tab visible in Vibe/Standard (not just Advanced/Dev). Default
   * false — an extra tab is a power-user affordance unless it opts in. Set for
   * first-class doc affordances (e.g. Translations).
   */
  availableInNonAdvanced?: boolean;
}

interface EditorWithSidePanelProps {
  /** The active editor surface (Milkdown or Monaco). Swapped by the caller — the side panel stays mounted. */
  children: ReactNode;
  /**
   * Serialized TypeId of the first-class entity this file belongs to (e.g.
   * `"plan-<uuid>"`, `"agent-<uuid>"`). Backlinks are keyed by this.
   * Null disables that tab's persistence (history empty).
   */
  target: string | null;
  /** Appended after Backlinks. Use for asset-type-specific tabs (e.g. workflow Runs). */
  extraTabs?: ExtraSideTab[];
}

/**
 * Editor-agnostic shell: any markdown editor as `children`, plus a tabbed side
 * window (Backlinks, extras). The side window is URL-first dock state —
 * the open set + active id live on the DockPointer (`?sideWindows=…`) and are
 * driven through the shared `useSideWindows` hook, identical to the interactive
 * terminal. Only opened windows show, each is closeable, and an empty set
 * collapses to a rail of openable buttons (one per registered window).
 *
 * To open a window programmatically (e.g. a header pill, or a run-start), a
 * caller calls `useSideWindows().open(id)` directly — there is no controlled
 * active-tab prop, because the URL is the single source of truth.
 */
export function EditorWithSidePanel({
  children,
  target,
  extraTabs,
}: EditorWithSidePanelProps) {
  const { windows, active, open, close, closeAll, select } = useSideWindows();
  const advanced = useIsAdvanced();

  // Registry of openable windows (Backlinks + caller extras), in display order.
  // Filtering here covers both the open drawer tabs and the collapsed rail, so
  // a persisted Advanced URL cannot leak a power-user tab into a simpler mode.
  const registry = useMemo<TabDescriptor[]>(() => {
    const extras: TabDescriptor[] = (extraTabs ?? []).map(({ id, label, icon, description }) => ({
      id,
      label,
      icon,
      description,
    }));
    const all = [BACKLINKS_TAB, ...extras];
    if (advanced) return all;
    // Non-Advanced: built-in always-on ids, plus any extra tab that opted in.
    const nonAdvancedExtraIds = new Set(
      (extraTabs ?? []).filter((t) => t.availableInNonAdvanced).map((t) => t.id),
    );
    return all.filter(
      (tab) => NON_ADVANCED_SIDE_TAB_IDS.has(tab.id) || nonAdvancedExtraIds.has(tab.id),
    );
  }, [advanced, extraTabs]);

  // A window this mode cannot show is IGNORED, never deleted from the URL.
  // Rendering already filters by `registry` (see `openTabs` below), so an
  // Advanced-only id in a Standard URL shows nothing — the leak this used to
  // "prune" was already impossible. Writing the URL to tidy it up was actively
  // harmful: the tab set grows as async data lands (a Duplicates tab only
  // exists once `duplicate_count` loads), so the pruner read "not declared
  // yet" as "not allowed here" and dropped a legitimate window — via a
  // history PUSH, which navigated the user off the entry Back had just
  // correctly restored. A view ignores state it cannot use; deleting it
  // requires an authority a mid-load render does not have.
  const panels = useMemo<Record<string, ReactNode>>(() => {
    const map: Record<string, ReactNode> = {
      backlinks: <BacklinksTab target={target} />,
    };
    for (const t of extraTabs ?? []) map[t.id] = t.panel;
    return map;
  }, [target, extraTabs]);

  // Open windows, in open order, narrowed to known registry ids (drops any
  // stale/foreign id) and marked closeable.
  const openTabs = useMemo<TabDescriptor[]>(
    () =>
      windows
        .map((id) => registry.find((r) => r.id === id))
        .filter((d): d is TabDescriptor => !!d)
        .map((d) => ({ ...d, closable: true })),
    [windows, registry],
  );
  const visibleActive = active && openTabs.some((tab) => tab.id === active) ? active : null;

  return (
    <div className="flex h-full w-full" data-testid="md-editor-with-side-panel">
      <div className="min-w-0 flex-1">{children}</div>
      {openTabs.length > 0 && (
        <TabbedSideDrawer<string>
          open
          onOpenChange={closeAll}
          closeIcon={PanelRightClose}
          closeLabel="Collapse side window"
          width="w-80"
          data-testid="md-side-window"
          tabTestIdPrefix="md-side-tab"
          tabs={openTabs}
          activeTab={visibleActive ?? openTabs[openTabs.length - 1].id}
          onActiveTabChange={select}
          onCloseTab={close}
          truncateLabels
          scrollableTabs
        >
          {panels}
        </TabbedSideDrawer>
      )}
      {/* When this mode has registered windows, the rail can open or re-activate
          each one at any time, whether the drawer is collapsed or already open. */}
      {registry.length > 0 && (
        <CollapsedSideRail data-testid="md-side-window-collapsed">
          {advanced && openTabs.length === 0 && (
            <SideRailButton
              icon={PanelRightOpen}
              label={t`Expand side window`}
              onClick={() => open(registry[0].id)}
              testId="md-side-window-expand"
            />
          )}
          {registry.map((tab) => (
            <SideRailButton
              key={tab.id}
              icon={tab.icon}
              label={tab.label}
              active={windows.includes(tab.id)}
              onClick={() => open(tab.id)}
              testId={`md-side-tab-collapsed-${tab.id}`}
            />
          ))}
        </CollapsedSideRail>
      )}
    </div>
  );
}
