import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
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
import {
  AgentTrace,
  AgenticProcess,
  dataManager,
  editorForType,
  Shell,
  Tab,
  tabKey,
  TabLifecycleState,
  TypeId,
  type TabLifecycleEntry,
} from '@sdk';
import { EntityIcon } from '@src/components/graph-view/ui/EntityIcon';
import { favoriteTargetForDock } from '@src/components/favorites/favorite-target';
import type { FavoriteRef } from '@src/hooks/use-favorites';
import { tabDock } from '@src/tabs/project-entry';
import { type TabStripItem } from '@src/components/tabs/TabStrip';
import { useEntity } from '@src/hooks/entity-hooks';
import { useLaunchingAgent } from '@src/hooks/use-launching-agent';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { lucideByName } from '@src/lib/lucide-by-name';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTabLifecycles } from '@src/tabs/use-tab-manager';
import { ContentTabTooltip, humanizeType, ProcessTabCard, PROVIDER_META } from '@src/tabs/provider-meta';
import { DocTabCard } from '@src/tabs/doc-tab-card';
import { EntityCard, UrlTabCard } from '@src/components/entity-card/EntityCard';
import { isReviewableDocDock } from '@src/navigation/content-asset-dock';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType, VIEWER_REGISTRY, viewerTitle } from '@src/types/ViewType';
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

/**
 * A session's chip icon: the AGENT's avatar when the session was launched as an
 * agent (its deployment names one — the same resolution the chat panel's intro
 * uses), else the provider glyph. The strip batch-loads chip processes, so the
 * process read is a cache hit; a session without a deployment fetches nothing.
 */
function ProcessTabIcon({ processId, fallback }: { processId: string; fallback: React.ReactNode }) {
  const typeId = useMemo(() => new TypeId(AgenticProcess.type, processId), [processId]);
  const process = useEntity<AgenticProcess>(typeId).data;
  const agent = useLaunchingAgent(process?.deployment_id);
  if (!agent) return <>{fallback}</>;
  return (
    <AgentAvatar
      agent={agent}
      className="h-4 w-4 shrink-0"
      glyphClassName="text-[11px] leading-none"
      data-testid="tab-agent-avatar"
    />
  );
}

/** Tab → chip, leading with the tab's own bookmark star when it has one to offer. */
export function tabItem(tab: Tab, lifecycle: TabLifecycleEntry | null = null): TabStripItem {
  const item = chipFor(tab, lifecycle);
  return { ...item, favorite: tabFavorite(tab, item.title) };
}

/** What bookmarking this tab means — the SAME answer the navigation bar's star
 *  gives when the tab is active (`favoriteTargetForDock` over its dock and that
 *  dock's target), so the two stars light together. */
function tabFavorite(tab: Tab, title: string): FavoriteRef | null {
  const dock = tabDock(tab);
  const typeId = dock?.targetTypeId ?? null;
  return favoriteTargetForDock(dock, typeId ? { typeId, entity: null } : null, title);
}

/** The review card for a tab whose dock is ONE document — nothing for any other
 *  tab. A node or `undefined`, never a null-rendering component: the strip
 *  decides which hover card to show by whether this is set. */
function docCard(props: Omit<React.ComponentProps<typeof DocTabCard>, 'dock'> & { dock?: DockPointer | null }) {
  const { dock } = props;
  if (!dock || !isReviewableDocDock(dock)) return undefined;
  return <DocTabCard {...props} dock={dock} />;
}

/** The card for the ONE entity a tab is — a shell, a conversation, an app, a project. */
function entityCard(type: string | null | undefined, id: string | null | undefined, name: string, statusReason?: string) {
  if (!type || !id) return undefined;
  return <EntityCard type={type} id={id} fallbackName={name} statusReason={statusReason} />;
}

/** A tab's own entity. A scope-keyed tab (the Assets browser) has none: its row
 *  keeps the target of whatever it showed last, while the tab reopens the browser. */
function tabEntityCard(tab: Tab, name: string, statusReason: string) {
  if (tab.dockPointer && new DockPointer(tab.dockPointer).scopeKeyed) return undefined;
  return entityCard(tab.target_type, tab.target_id, name, statusReason || undefined);
}

function chipFor(tab: Tab, lifecycle: TabLifecycleEntry | null): TabStripItem {
  const dock = tab.dockPointer;
  const key = tabKey(tab);
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
    const providerIcon = (
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${meta.iconClassName}`}
        data-provider={kind}
        aria-label={i18n._(meta.label)}
      />
    );
    return {
      key,
      title: label || i18n._(meta.label),
      titleClassName,
      icon: processId ? <ProcessTabIcon processId={processId} fallback={providerIcon} /> : providerIcon,
      // Worktree glyph. What the agent has shown lives on the process's bottom
      // ribbon (the Shown chip beside Open Plan), not on its tab chip.
      badge: tab.worktree ? <FolderGit2 className="h-3 w-3 shrink-0 text-amber-500" /> : undefined,
      isDisabled,
      hasError: lifecycleOverlay.hasError,
      statusReason,
      renameable: true,
      card: processId ? (
        <ProcessTabCard
          processId={processId}
          fallbackName={label || i18n._(meta.label)}
          statusReason={statusReason || undefined}
        />
      ) : (
        tabEntityCard(tab, label || i18n._(meta.label), statusReason)
      ),
      tooltip: statusReason || undefined,
      testId: `tab-${key}`,
      dataAttributes: { 'data-indicator-key': key },
    };
  }

  // Content tab: per-type icon from the backend TypeInfo registry when the dock
  // has a target entity (CLAUDE.md icon rule), else the viewType registry glyph.
  const meta = VIEWER_REGISTRY[viewType as ViewType];
  const docDock = dock ? new DockPointer(dock) : null;
  if (tab.target_type && tab.target_id) {
    const typeLabel = viewerTitle(viewType) || humanizeType(tab.target_type);
    return {
      key,
      title: label || viewerTitle(viewType) || viewType,
      titleClassName,
      icon: (
        <EntityIcon
          type={tab.target_type}
          remote={tab.target_remote}
          density="compact"
          showLocationTooltip={false}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label={`${tab.target_type} tab`}
        />
      ),
      renameable: true,
      isDisabled,
      hasError: lifecycleOverlay.hasError,
      statusReason,
      guestNote: isGuestTab(tab) ? i18n._(msg`This asset is not part of this project`) : undefined,
      card:
        docCard({ tab, dock: docDock, typeLabel, statusReason: statusReason || undefined, location: tab.target_remote }) ??
        tabEntityCard(tab, label || typeLabel, statusReason),
      tooltip: (
        <ContentTabTooltip
          tab={tab}
          typeLabel={typeLabel}
          statusReason={statusReason || undefined}
          location={tab.target_remote}
        />
      ),
      testId: `tab-content-${key}`,
      dataAttributes: { 'data-tab-kind': tab.target_type },
    };
  }
  const Icon = (meta?.iconName && lucideByName(meta.iconName)) || FileText;
  const typeLabel = viewerTitle(viewType) || humanizeType(viewType || 'Tab');
  return {
    key,
    title: label || viewerTitle(viewType) || viewType,
    titleClassName,
    icon: <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
    renameable: false,
    isDisabled,
    hasError: lifecycleOverlay.hasError,
    statusReason,
    card:
      docCard({ tab, dock: docDock, typeLabel, statusReason: statusReason || undefined }) ??
      (docDock?.webUrl ? <UrlTabCard name={label || typeLabel} url={docDock.webUrl} /> : undefined),
    tooltip: <ContentTabTooltip tab={tab} typeLabel={typeLabel} statusReason={statusReason || undefined} />,
    testId: `tab-content-${key}`,
  };
}

/** A guest tab shows content owned by another project than the tab's own. Both
 *  ids must be known — a projectless tab or target is never a guest. */
export function isGuestTab(tab: Pick<Tab, 'project_id' | 'target_project_id'>): boolean {
  return !!tab.project_id && !!tab.target_project_id && tab.project_id !== tab.target_project_id;
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
  const focusVfsFilename = currentDock?.viewType === ViewType.ASSETS ? currentDock.vfsPath?.filename || null : null;
  const focusTypeId = currentDock?.viewType === ViewType.ASSETS ? (currentDock.targetTypeId ?? null) : null;
  const focusType = focusTypeId?.type;
  const focusId = focusTypeId?.id;
  const focusEditable = !!(focusType && editorForType(focusType));
  const focusEntity = focusTypeId
    ? (dataManager.getByTypeIdFromCache(focusTypeId) as {
        displayName?: string | null;
        remote?: boolean;
      } | null)
    : null;
  // An agent_trace's chip shows the ORIGINAL analyzed-process name (e.g.
  // "deferred-save-background-sweeper") — the Route icon already reads as
  // "analysis", so the prefixed "SubAgent analysis: …" title (which the header
  // carries) would only waste the narrow tab. Subscribe to that process so the
  // chip upgrades the moment its row loads.
  const focusTrace = focusType === 'agent_trace' ? (focusEntity as AgentTrace | null) : null;
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
  const activeAssetTitle = focusVfsFilename ?? (focusEditable ? (titleSource?.displayName?.trim() ?? null) : null);

  return useMemo(
    () =>
      tabs.map((tab) => {
        const key = tabKey(tab);
        const item = tabItem(tab, lifecycles.get(key) ?? null);
        if (key === currentDock?.tabHash && activeAssetTitle) {
          item.title = activeAssetTitle;
        }
        // The ACTIVE Assets tab follows the asset on screen: its icon, tooltip and card.
        if (key === currentDock?.tabHash && currentDock.viewType === ViewType.ASSETS) {
          const remote = focusEntity?.remote ?? tab.target_remote;
          const typeLabel = viewerTitle(ViewType.ASSETS) || humanizeType(focusType ?? '');
          const statusReason = item.statusReason || undefined;
          if (focusType && focusEditable) {
            item.icon = (
              <EntityIcon
                type={focusType}
                remote={remote}
                density="compact"
                showLocationTooltip={false}
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-label={`${focusType} tab`}
              />
            );
            item.tooltip = (
              <ContentTabTooltip tab={tab} typeLabel={typeLabel} statusReason={statusReason} location={remote} />
            );
          }
          // A path-addressed document has no `focusType`, and still gets its card.
          item.card =
            docCard({ tab, dock: currentDock, typeLabel, statusReason, location: remote, name: item.title }) ??
            entityCard(focusType, focusId, item.title, statusReason);
        }
        return item;
      }),
    [tabs, lifecycles, currentDock, focusType, focusId, focusEditable, focusEntity, activeAssetTitle],
  );
}
