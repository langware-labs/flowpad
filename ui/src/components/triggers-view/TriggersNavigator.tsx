import { useCallback, useMemo } from 'react';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { type ITrigger } from '@sdk';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import { useTriggers } from '@src/hooks/useTriggers';
import { useProject } from '@src/hooks/useProject';
import { TriggersList } from './TriggersList';

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
      header: { title: 'Triggers', countBadge: triggers.length },
      customBody: (
        <TriggersList
          triggers={triggers}
          selectedTrigger={selectedTrigger}
          onSelect={handleSelect}
          onOpenLog={handleOpenLog}
          onNewSchedule={handleNewSchedule}
          isCreatingSchedule={isCreatingSchedule}
          currentProjectId={project?.id ?? null}
          currentProjectName={project?.getDisplayName() ?? project?.name ?? null}
          scope={urlScope}
          onScopeChange={handleScopeChange}
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
    ],
  );

  return <NavigatorPanel descriptor={descriptor} />;
}
