import { Badge } from '@src/components/ui/badge';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { useCallback, useState } from 'react';
import { type ITrigger } from '@sdk';
import { useTriggers } from '@src/hooks/useTriggers';
import { TriggersList } from './TriggersList';
import { TriggerEditor } from './TriggerEditor';
import { ScheduleTriggerEditor } from './ScheduleTriggerEditor';
import { TriggerInvocationsPanel } from './TriggerInvocationsPanel';

export function TriggersView() {
  const { triggers, isLoading: loading } = useTriggers();
  const [selectedTrigger, setSelectedTrigger] = useState<ITrigger | null>(null);
  const [isCreatingSchedule, setIsCreatingSchedule] = useState(false);
  const { navigation } = useDockNavigation();

  const openLog = useCallback((trigger: ITrigger) => {
    if (trigger.id) {
      navigation.openTab(ViewType.LENS, DockPointer.forLens('trigger', 'log', trigger.id));
    }
  }, [navigation]);

  const handleScheduleSaved = (saved: ITrigger) => {
    setIsCreatingSchedule(false);
    setSelectedTrigger(saved);
  };

  const handleNewSchedule = () => {
    setIsCreatingSchedule(true);
    setSelectedTrigger(null);
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading triggers...</div>;
  }

  // Determine center panel content
  const renderCenter = () => {
    if (isCreatingSchedule) {
      return (
        <ScheduleTriggerEditor
          trigger={null}
          onSaved={handleScheduleSaved}
          onCancel={() => setIsCreatingSchedule(false)}
        />
      );
    }
    if (!selectedTrigger) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Select a trigger to edit
        </div>
      );
    }
    if (selectedTrigger.trigger_type === 'schedule') {
      return (
        <ScheduleTriggerEditor
          trigger={selectedTrigger}
          onSaved={handleScheduleSaved}
          onCancel={() => setSelectedTrigger(null)}
        />
      );
    }
    return <TriggerEditor trigger={selectedTrigger} />;
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — trigger list */}
      <div className="flex w-[280px] flex-shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">Triggers</span>
          <Badge variant="secondary" className="text-[10px]">{triggers.length}</Badge>
        </div>
        <div className="flex-1 overflow-auto">
          <TriggersList
            triggers={triggers}
            selectedTrigger={selectedTrigger}
            onSelect={(t) => { setSelectedTrigger(t); setIsCreatingSchedule(false); }}
            onOpenLog={openLog}
            onLogModeChange={() => {/* cache updates via useEntitiesQuery */}}
            onNewSchedule={handleNewSchedule}
            isCreatingSchedule={isCreatingSchedule}
          />
        </div>
      </div>

      {/* Center panel — type-specific editor */}
      <div className="flex flex-1 flex-col overflow-hidden border-r">
        {renderCenter()}
      </div>

      {/* Right panel — invocations */}
      <div className="flex w-[300px] flex-shrink-0 flex-col">
        <TriggerInvocationsPanel trigger={isCreatingSchedule ? null : selectedTrigger} />
      </div>
    </div>
  );
}
