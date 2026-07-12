/**
 * One ordering, one chip shape. `tabItem` maps a backend `Tab` (the single
 * render source) → a `TabStripItem` for EVERY tab kind — terminal (shell /
 * agentic_process) and content (markdown / asset / settings / search / diff / …).
 * The terminal-vs-content split is gone: a chip is keyed by its `dockPointer.tabHash`,
 * so the strip is homogeneous and the active chip is just `currentDock.tabHash`.
 *
 * Display data is backend-resolved on the Tab (`name`, `icon_key`, `worktree`,
 * `status`/`is_disabled`).
 */
import { AgentTrace, AgenticProcess, dataManager, editorForType, Shell, Tab, TypeId } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { type TabStripItem } from '@src/components/tabs/TabStrip';
import { useEntity } from '@src/hooks/entity-hooks';
import { lucideByName } from '@src/lib/lucide-by-name';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { TabLifecycleState, type TabLifecycleEntry, useTabLifecycles } from '@src/tabs/tab-lifecycle';
import { ContentTabTooltip, humanizeType, LazyProcessTooltip, PROVIDER_META } from '@src/tabs/provider-meta';
import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import { FileText, FolderGit2 } from 'lucide-react';
import React, { useMemo } from 'react';

const TERMINAL_TARGET_TYPES = new Set<string>([Shell.type, AgenticProcess.type]);

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

/** Tab → chip. */
export function tabItem(tab: Tab, lifecycle: TabLifecycleEntry | null = null): TabStripItem {
  // DockPointer from the stored JSON pointer; key is the tabHash.
  const dock = tab.dockPointer;
  const key = dock?.tabHash ?? tab.id;
  // No char-level clipping: CSS truncation in the strip owns visible clipping
  // at every chip width, and tooltips need the full name.
  const label = tab.name ?? '';
  const viewType = dock?.viewType || '';
  const lifecycleOverlay = lifecycleStatus(lifecycle);
  const isDisabled = lifecycleOverlay.isClosing || tab.is_disabled;
  const statusReason = lifecycleOverlay.statusReason || (tab.is_disabled ? 'Closing...' : '');
  // Projectless ("global") tabs live in the Global scope; mark their title with
  // the same violet the Global chip uses, so a global tab and its scope chip read
  // as one visual language.
  const titleClassName = tab.project_id == null ? 'text-violet-500' : undefined;

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

/** Map the ordered tabs → chips. */
export function useTabStripItems(tabs: Tab[]): TabStripItem[] {
  const lifecycles = useTabLifecycles();
  const { currentDock } = useDockNavigation();

  // The scope-keyed Assets browser tab is reused verbatim across in-tab
  // navigation, so its stored name/icon (scope: "<project>'s Assets") are frozen
  // at creation and can't track the asset you're viewing. For the ACTIVE Assets
  // tab we overlay the focused asset live from the current dock — its own name +
  // type icon — leaving inactive assets tabs on their stored scope title.
  const focusTypeId = currentDock?.viewType === 'assets' ? currentDock.targetTypeId ?? null : null;
  const focusType = focusTypeId?.type;
  const focusEditable = !!(focusType && editorForType(focusType));
  const focusEntity = focusTypeId
    ? (dataManager.getByTypeIdFromCache(focusTypeId) as { displayName?: string | null } | null)
    : null;
  // An agent_trace's chip shows the ORIGINAL analyzed-process name (e.g.
  // "deferred-save-background-sweeper") — the Route icon already reads as
  // "analysis", so the prefixed "Agent analysis: …" title (which the header
  // carries) would only waste the narrow tab. Subscribe to that process so the
  // chip upgrades the moment its row loads.
  const focusTrace =
    focusType === 'agent_trace' ? (focusEntity as AgentTrace | null) : null;
  const procTypeId = focusTrace?.analyzed_process_id
    ? new TypeId(AgenticProcess.type, focusTrace.analyzed_process_id)
    : null;
  const { data: focusProcess } = useEntity<AgenticProcess>(procTypeId, {
    enabled: !!procTypeId,
    watch: true,
  });
  // The displayed name comes from the focused entity, except an agent_trace
  // shows its analyzed process's name instead (resolved reactively above).
  const titleSource = focusType === 'agent_trace' ? focusProcess : focusEntity;
  const activeAssetTitle = focusEditable ? (titleSource?.displayName?.trim() ?? null) : null;

  return useMemo(
    () =>
      tabs.map((t) => {
        const key = t.dockPointer?.tabHash ?? t.id;
        const item = tabItem(t, lifecycles.get(key) ?? null);
        // `focusType` is only set on an assets dock, so it implies viewType==='assets'.
        if (key === currentDock?.tabHash && focusType && focusEditable) {
          if (activeAssetTitle) item.title = activeAssetTitle;
          const Icon = iconForType(focusType);
          item.icon = (
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={`${focusType} tab`} />
          );
        }
        return item;
      }),
    [tabs, lifecycles, currentDock, focusType, focusEditable, activeAssetTitle],
  );
}

// Backward-compat alias for migration
export const tabRowItem = tabItem;
