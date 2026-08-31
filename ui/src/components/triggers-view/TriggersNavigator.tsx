import { useCallback, useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trigger } from '@sdk';
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
 * into the dock OPTIONS (`DockPointer.forEvents`), which `EventsView` reads.
 */
export function TriggersNavigator() {
  const { t } = useLingui();
  const { triggers } = useTriggers();
  const { project } = useProject();
  const { navigation, currentDock } = useDockNavigation();

  // System rules ride a separate visibility toggle (the unified ScopeFilter
  // shape is `{mode, user, projects}` and can't carry `system`). It lives in the
  // URL, not in component state, because the events FEED has to apply the same
  // rule — a system rule's fires must appear exactly when the rule itself is
  // listed. Local state here meant the body silently dropped them.
  const includeSystem = currentDock?.options?.system === '1';

  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? defaultScopeFilter(project?.id ?? null),
    [currentDock, project?.id],
  );

  const setIncludeSystem = useCallback(
    (next: boolean) => {
      navigation.openDock(
        DockPointer.forEvents(
          currentDock?.options?.trigger,
          { creating: currentDock?.options?.creating, system: next },
        ).withScopeFilter(urlScope),
      );
    },
    [navigation, currentDock, urlScope],
  );

  const hiddenSystemCount = includeSystem
    ? 0
    : triggers.filter((t) => (t.scope || 'user') === 'system').length;

  const selectedTrigger = useMemo<Trigger | null>(() => {
    const id = currentDock?.options?.trigger;
    return id ? triggers.find((t) => t.id === id) ?? null : null;
  }, [currentDock, triggers]);
  const isCreatingSchedule = currentDock?.options?.creating === 'schedule';

  const handleScopeChange = useCallback(
    (scope: ScopeFilter) => {
      const base = currentDock ?? DockPointer.forEvents();
      navigation.openDock(base.withScopeFilter(scope));
    },
    [currentDock, navigation],
  );

  // `system` has to be carried through every navigation, not just set by the
  // toggle: selecting a rule while system rules are shown must not hide them
  // (and would hide the very rule you just clicked).
  const handleSelect = useCallback(
    (t: Trigger) => {
      if (!t.id) return;
      navigation.openDock(
        DockPointer.forEvents(t.id, { system: includeSystem }).withScopeFilter(urlScope),
      );
    },
    [navigation, urlScope, includeSystem],
  );

  const handleNewSchedule = useCallback(() => {
    navigation.openDock(
      DockPointer.forEvents(undefined, { creating: 'schedule', system: includeSystem })
        .withScopeFilter(urlScope),
    );
  }, [navigation, urlScope, includeSystem]);

  const handleOpenLog = useCallback(
    (t: Trigger) => {
      if (t.id) navigation.openDock(DockPointer.forLens('trigger', 'log', t.id));
    },
    [navigation],
  );

  const descriptor: NavigatorDescriptor = useMemo(
    () => ({
      id: 'triggers',
      search: { recordTypes: ['trigger'], scope: urlScope, placeholder: t`Search rules…` },
      header: {
        title: t`Rules`,
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
      setIncludeSystem,
      t,
      hiddenSystemCount,
    ],
  );

  return <NavigatorPanel descriptor={descriptor} />;
}
