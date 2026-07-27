import { useCallback, useMemo, useState } from 'react';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { type ITrigger } from '@sdk';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import { useTriggers } from '@src/hooks/useTriggers';
import { useProject } from '@src/hooks/useProject';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { TriggersList } from './TriggersList';
import { TriggersFilterBar } from './TriggersFilterBar';

/**
 * Triggers left-menu — the navigator (Zone B). The rich list (per-type
 * sections, sub-scope grouping, live interactive rows, help popovers) renders
 * as the panel's `customBody`; the panel owns collapse/resize/persistence + the
 * header. Selection is URL-first: clicking a row writes the selected trigger id
 * into the dock OPTIONS (`DockPointer.forTriggers`), which `TriggersView` reads.
 */
export function TriggersNavigator() {
  const { triggers } = useTriggers();
  const { project } = useProject();
  const { navigation, currentDock } = useDockNavigation();

  // System triggers ride a separate visibility toggle (the unified ScopeFilter
  // shape is `{user, projects}` and can't carry `system`). Kept here so the header
  // filter bar and the list body share one source of truth.
  const [includeSystem, setIncludeSystem] = useState(false);

  const hiddenSystemCount = includeSystem
    ? 0
    : triggers.filter((t) => (t.scope || 'user') === 'system').length;

  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? defaultScopeFilter(project?.id ?? null),
    [currentDock, project?.id],
  );

  const selectedTrigger = useMemo<ITrigger | null>(() => {
    const id = currentDock?.options?.trigger;
    return id ? triggers.find((t) => t.id === id) ?? null : null;
  }, [currentDock, triggers]);
  const isCreatingSchedule = currentDock?.options?.creating === 'schedule';

  const handleScopeChange = useCallback(
    (scope: ScopeFilter) => {
      const base = currentDock ?? DockPointer.forTriggers();
      navigation.openDock(base.withScopeFilter(scope));
    },
    [currentDock, navigation],
  );

  const handleSelect = useCallback(
    (t: ITrigger) => {
      if (!t.id) return;
      navigation.openDock(DockPointer.forTriggers(t.id).withScopeFilter(urlScope));
    },
    [navigation, urlScope],
  );

  const handleNewSchedule = useCallback(() => {
    navigation.openDock(DockPointer.forTriggers(undefined, { creating: 'schedule' }).withScopeFilter(urlScope));
  }, [navigation, urlScope]);

  const handleOpenLog = useCallback(
    (t: ITrigger) => {
      if (t.id) navigation.openTab(ViewType.LENS, DockPointer.forLens('trigger', 'log', t.id));
    },
    [navigation],
  );

  const descriptor: NavigatorDescriptor = useMemo(
    () => ({
      id: 'triggers',
      search: { recordTypes: ['trigger'], scope: urlScope, placeholder: 'Search triggers…' },
      header: {
        title: 'Triggers',
        countBadge: triggers.length,
        headerRight: (
          <ScopeFilterIconBar
            scope={urlScope}
            currentProjectId={project?.id ?? null}
            currentProjectName={project?.getDisplayName() ?? project?.name ?? null}
            onScopeChange={handleScopeChange}
          />
        ),
        filterBar: (
          <TriggersFilterBar
            includeSystem={includeSystem}
            onIncludeSystemChange={setIncludeSystem}
            hiddenSystemCount={hiddenSystemCount}
          />
        ),
      },
      customBody: (
        <TriggersList
          triggers={triggers}
          selectedTrigger={selectedTrigger}
          onSelect={handleSelect}
          onOpenLog={handleOpenLog}
          onNewSchedule={handleNewSchedule}
          isCreatingSchedule={isCreatingSchedule}
          scope={urlScope}
          includeSystem={includeSystem}
        />
      ),
    }),
    [
      triggers,
      selectedTrigger,
      isCreatingSchedule,
      handleSelect,
      handleOpenLog,
      handleNewSchedule,
      handleScopeChange,
      project,
      urlScope,
      includeSystem,
      hiddenSystemCount,
    ],
  );

  return <NavigatorPanel descriptor={descriptor} />;
}
