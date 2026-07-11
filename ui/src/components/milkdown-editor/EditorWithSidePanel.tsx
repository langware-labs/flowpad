import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { Link2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useIsAdvanced } from '@src/components/view-mode';
import { TabbedSideDrawer, type TabDescriptor } from '@src/components/ui/side-drawer';
import { CollapsedSideRail, SideRailButton } from '@src/components/ui/collapsed-side-rail';
import { useSideWindows } from '@src/navigation/useSideWindows';
import { BacklinksTab } from './side-windows';

// The one built-in side window; asset editors append extras via `extraTabs`.
const BACKLINKS_TAB: TabDescriptor = {
  id: 'backlinks',
  label: 'Backlinks',
  icon: Link2,
  description: 'Documents that link here',
};

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

  // Standard mode: the side window is closed by default — collapse any
  // persisted/shared-open windows once on entry (and again whenever the user
  // drops from Advanced back to Standard) so a Standard user lands on the rail.
  // The rail stays, so they can still open a window for the session.
  const didStandardCollapse = useRef(false);
  useEffect(() => {
    if (advanced) {
      didStandardCollapse.current = false;
      return;
    }
    if (didStandardCollapse.current) return;
    didStandardCollapse.current = true;
    if (windows.length > 0) closeAll();
  }, [advanced, windows, closeAll]);

  // Full registry of openable windows (Backlinks + caller extras), in
  // display order. Drives both the open-tab descriptors and the collapsed rail.
  const registry = useMemo<TabDescriptor[]>(() => {
    const extras: TabDescriptor[] = (extraTabs ?? []).map(({ id, label, icon, description }) => ({
      id,
      label,
      icon,
      description,
    }));
    return [BACKLINKS_TAB, ...extras];
  }, [extraTabs]);

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
          activeTab={active ?? openTabs[openTabs.length - 1].id}
          onActiveTabChange={select}
          onCloseTab={close}
          truncateLabels
          scrollableTabs
        >
          {panels}
        </TabbedSideDrawer>
      )}
      {/* The rail is always present (like the terminal's ribbon): every
          registered window can be opened — or re-activated, when already open —
          at any time, whether the drawer is collapsed or showing other windows. */}
      <CollapsedSideRail data-testid="md-side-window-collapsed">
        {openTabs.length === 0 && (
          <SideRailButton
            icon={PanelRightOpen}
            label="Expand side window"
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
    </div>
  );
}
