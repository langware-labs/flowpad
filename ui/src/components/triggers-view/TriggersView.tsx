import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useCallback, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { type ITrigger } from '@sdk';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import { useTriggers } from '@src/hooks/useTriggers';
import { useProject } from '@src/hooks/useProject';
import { TriggerEditor } from './TriggerEditor';
import { ScheduleTriggerEditor } from './ScheduleTriggerEditor';
import { FsopTriggerDetail } from './FsopTriggerDetail';
import { TriggerInvocationsPanel } from './TriggerInvocationsPanel';

/**
 * Triggers body — the center editor + right invocations panel for the trigger
 * addressed by the URL. The list moved to `TriggersNavigator` (the shared Zone
 * B left menu); selection is URL-first: the selected trigger id and the
 * transient "creating" mode live in the dock OPTIONS
 * (`DockPointer.forTriggers`), read here via `currentDock.options`.
 */
export function TriggersView() {
  const { triggers, isLoading: loading } = useTriggers();
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

  const clearSelection = useCallback(() => {
    navigation.openDock(DockPointer.forTriggers().withScopeFilter(urlScope));
  }, [navigation, urlScope]);

  const startNewSchedule = useCallback(() => {
    navigation.openDock(DockPointer.forTriggers(undefined, { creating: 'schedule' }).withScopeFilter(urlScope));
  }, [navigation, urlScope]);

  const handleScheduleSaved = useCallback(
    (saved: ITrigger) => {
      if (saved.id) navigation.openDock(DockPointer.forTriggers(saved.id).withScopeFilter(urlScope));
      else clearSelection();
    },
    [navigation, urlScope, clearSelection],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading triggers...</div>
    );
  }

  const renderCenter = () => {
    if (isCreatingSchedule) {
      return <ScheduleTriggerEditor trigger={null} onSaved={handleScheduleSaved} onCancel={clearSelection} />;
    }
    if (!selectedTrigger) {
      if (triggers.length === 0) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
            <p className="text-sm">No triggers yet</p>
            <Button variant="outline" size="sm" className="gap-2" onClick={startNewSchedule}>
              <Plus className="h-4 w-4" />
              New Schedule Trigger
            </Button>
            <p className="max-w-xs text-center text-xs text-muted-foreground/70">
              Hook triggers come from rule files under{' '}
              <code className="rounded bg-muted px-1">~/.flow/skill_rules/</code>. FSOp triggers are installed by the
              system or via the API.
            </p>
          </div>
        );
      }
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Select a trigger to view
        </div>
      );
    }
    switch (selectedTrigger.trigger_type) {
      case 'schedule':
        return <ScheduleTriggerEditor trigger={selectedTrigger} onSaved={handleScheduleSaved} onCancel={clearSelection} />;
      case 'fsop':
        return <FsopTriggerDetail key={selectedTrigger.id} trigger={selectedTrigger} />;
      case 'hook':
      default:
        return <TriggerEditor trigger={selectedTrigger} />;
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Center panel — type-specific editor */}
      <div className="flex flex-1 flex-col overflow-hidden border-r">{renderCenter()}</div>

      {/* Right panel — invocations */}
      <div className="flex w-[300px] flex-shrink-0 flex-col">
        <TriggerInvocationsPanel trigger={isCreatingSchedule ? null : selectedTrigger} />
      </div>
    </div>
  );
}
