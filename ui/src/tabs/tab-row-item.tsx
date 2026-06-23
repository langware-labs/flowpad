/**
 * One ordering, one chip shape. `tabItem` maps a backend `Tab` (the single
 * render source) → a `TabStripItem` for EVERY tab kind — terminal (shell /
 * agentic_process) and content (markdown / asset / settings / search / diff / …).
 * The terminal-vs-content split is gone: a chip is keyed by its `dockPointer.tabHash`,
 * so the strip is homogeneous and the active chip is just `currentDock.tabHash`.
 *
 * Display data is backend-resolved on the Tab (`name`, `icon_key`, `worktree`,
 * `status`/`is_disabled`); the only client-side overlay is the pending-glow,
 * keyed by the process id.
 */
import { AgenticProcess, Shell, Tab } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { type TabStripItem } from '@src/components/tabs/TabStrip';
import { lucideByName } from '@src/lib/lucide-by-name';
import { usePendingSessionIds } from '@src/store/pending-actions-store';
import { TabLifecycleState, type TabLifecycleEntry, useTabLifecycles } from '@src/tabs/tab-lifecycle';
import { ContentTabTooltip, humanizeType, LazyProcessTooltip, PROVIDER_META } from '@src/tabs/provider-meta';
import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import { FileText, FolderGit2 } from 'lucide-react';
import React, { useMemo } from 'react';

const TERMINAL_TARGET_TYPES = new Set<string>([Shell.type, AgenticProcess.type]);
const TAB_LABEL_MAX = 30;

function clip(name: string): string {
  return name.length > TAB_LABEL_MAX ? name.slice(0, TAB_LABEL_MAX).trimEnd() + '…' : name;
}

function lifecycleStatus(lifecycle: TabLifecycleEntry | null): {
  hasError: boolean;
  isClosing: boolean;
  statusReason: string;
} {
  if (!lifecycle) return { hasError: false, isClosing: false, statusReason: '' };
  if (lifecycle.state === TabLifecycleState.Closing) {
    return { hasError: false, isClosing: true, statusReason: 'Closing...' };
  }
  if (lifecycle.state === TabLifecycleState.OpenFailed) {
    return { hasError: true, isClosing: false, statusReason: lifecycle.error || 'Tab failed to open' };
  }
  if (lifecycle.state === TabLifecycleState.CloseFailed) {
    return { hasError: true, isClosing: false, statusReason: lifecycle.error || 'Tab failed to close' };
  }
  return { hasError: false, isClosing: false, statusReason: '' };
}

/** Tab → chip. `isPending` is the only caller-supplied glow overlay. */
export function tabItem(tab: Tab, isPending: boolean, lifecycle: TabLifecycleEntry | null = null): TabStripItem {
  // DockPointer from the stored JSON pointer; key is the tabHash.
  const dock = tab.dockPointer;
  const key = dock?.tabHash ?? tab.id;
  const label = clip(tab.name ?? '');
  const viewType = dock?.viewType || '';
  const lifecycleOverlay = lifecycleStatus(lifecycle);
  const isDisabled = lifecycleOverlay.isClosing || tab.is_disabled;
  const statusReason = lifecycleOverlay.statusReason || (tab.is_disabled ? 'Closing...' : '');
  // Projectless ("global") tabs surface in every project's strip; mark them in
  // blue so it's clear they don't belong to the active project.
  const titleClassName = tab.project_id == null ? 'text-blue-500' : undefined;

  if (TERMINAL_TARGET_TYPES.has(tab.target_type ?? '')) {
    const kind = (tab.icon_key && tab.icon_key in PROVIDER_META ? tab.icon_key : 'shell') as keyof typeof PROVIDER_META;
    const meta = PROVIDER_META[kind];
    const Icon = meta.Icon;
    const processId = tab.target_type === AgenticProcess.type ? tab.target_id : null;
    return {
      key,
      title: label || meta.label,
      titleClassName,
      icon: (
        <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.iconClassName}`} data-provider={kind} aria-label={meta.label} />
      ),
      badge: tab.worktree ? <FolderGit2 className="h-3 w-3 shrink-0 text-amber-500" /> : undefined,
      isDisabled,
      hasError: lifecycleOverlay.hasError,
      statusReason,
      isPending,
      renameable: true,
      tooltip: processId ? (
        <LazyProcessTooltip
          processId={processId}
          fallbackName={label || meta.label}
          statusReason={statusReason || undefined}
        />
      ) : statusReason ? (
        statusReason
      ) : undefined,
      testId: `tab-${key}`,
      dataAttributes: { 'data-indicator-key': key },
    };
  }

  // Content tab: per-type icon from the backend TypeInfo registry when the dock
  // has a target entity (CLAUDE.md icon rule), else the viewType registry glyph.
  const meta = VIEWER_REGISTRY[viewType as ViewType];
  if (tab.target_type && tab.target_id) {
    const Icon = iconForType(tab.target_type);
    const typeLabel = meta?.title || humanizeType(tab.target_type);
    return {
      key,
      title: label || meta?.title || viewType,
      titleClassName,
      icon: <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={`${tab.target_type} tab`} />,
      renameable: true,
      isDisabled,
      hasError: lifecycleOverlay.hasError,
      statusReason,
      tooltip: <ContentTabTooltip tab={tab} typeLabel={typeLabel} statusReason={statusReason || undefined} />,
      testId: `tab-content-${key}`,
      dataAttributes: { 'data-tab-kind': tab.target_type },
    };
  }
  const Icon = (meta?.iconName && lucideByName(meta.iconName)) || FileText;
  const typeLabel = meta?.title || humanizeType(viewType || 'Tab');
  return {
    key,
    title: label || meta?.title || viewType,
    titleClassName,
    icon: <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
    renameable: false,
    isDisabled,
    hasError: lifecycleOverlay.hasError,
    statusReason,
    tooltip: <ContentTabTooltip tab={tab} typeLabel={typeLabel} statusReason={statusReason || undefined} />,
    testId: `tab-content-${key}`,
  };
}

/** Map the ordered tabs → chips, overlaying the pending-glow by process id. */
export function useTabStripItems(tabs: Tab[]): TabStripItem[] {
  const pending = usePendingSessionIds();
  const lifecycles = useTabLifecycles();
  return useMemo(
    () =>
      tabs.map((t) => {
        const key = t.dockPointer?.tabHash ?? t.id;
        return tabItem(t, t.target_id ? pending.has(t.target_id) : false, lifecycles.get(key) ?? null);
      }),
    [tabs, pending, lifecycles],
  );
}

// Backward-compat alias for migration
export const tabRowItem = tabItem;
