import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { type ITrigger } from '@sdk';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { TriggerListItem } from './TriggerListItem';

interface Props {
  triggers: ITrigger[];
  selectedTrigger: ITrigger | null;
  onSelect: (trigger: ITrigger) => void;
  onOpenLog: (trigger: ITrigger) => void;
  onLogModeChange: (triggerId: string, mode: string) => void;
  onNewSchedule: () => void;
  isCreatingSchedule: boolean;
}

const SCOPE_ORDER = ['system', 'user', 'project'] as const;
const SCOPE_LABELS: Record<string, string> = { system: 'System', user: 'User', project: 'Project' };

function groupByScope(triggers: ITrigger[]): Record<string, ITrigger[]> {
  const grouped: Record<string, ITrigger[]> = {};
  for (const trigger of triggers) {
    const scope = trigger.scope || 'user';
    if (!grouped[scope]) grouped[scope] = [];
    grouped[scope].push(trigger);
  }
  return grouped;
}

export function TriggersList({
  triggers,
  selectedTrigger,
  onSelect,
  onOpenLog,
  onLogModeChange,
  onNewSchedule,
  isCreatingSchedule,
}: Props) {
  const [showSystem, setShowSystem] = useState(false);

  const visibleTriggers = showSystem ? triggers : triggers.filter(t => t.scope !== 'system');
  const hookTriggers = visibleTriggers.filter(t => (t.trigger_type ?? 'hook') === 'hook');
  const scheduleTriggers = visibleTriggers.filter(t => t.trigger_type === 'schedule');

  const hookGrouped = groupByScope(hookTriggers);
  const scheduleGrouped = groupByScope(scheduleTriggers);

  const hiddenSystemCount = showSystem ? 0 : triggers.filter(t => t.scope === 'system').length;

  return (
    <div>
      {/* Top filter row */}
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
        <Checkbox
          id="triggers-show-system"
          checked={showSystem}
          onCheckedChange={(v) => setShowSystem(v === true)}
          className="h-3 w-3"
        />
        <label htmlFor="triggers-show-system" className="cursor-pointer select-none text-[10px] text-muted-foreground">
          Show system triggers
          {hiddenSystemCount > 0 && <span className="ml-1 text-muted-foreground/60">({hiddenSystemCount})</span>}
        </label>
      </div>

      {/* Schedule Triggers section */}
      <div>
        <div className="sticky top-0 flex items-center gap-1 bg-muted/70 px-3 py-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
            Schedule Triggers
          </span>
          <Button
            variant="ghost"
            size="icon"
            className={`h-4 w-4 ${isCreatingSchedule ? 'text-primary' : ''}`}
            onClick={onNewSchedule}
            title="New schedule trigger"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        {SCOPE_ORDER.filter(s => scheduleGrouped[s]?.length).map(scope => (
          <div key={scope}>
            <div className="sticky top-5 bg-muted/50 px-3 py-0.5 text-[10px] font-medium text-muted-foreground/70">
              {SCOPE_LABELS[scope]}
            </div>
            {scheduleGrouped[scope].map(trigger => (
              <TriggerListItem
                key={trigger.id || trigger.name}
                trigger={trigger}
                isSelected={selectedTrigger?.id === trigger.id}
                onSelect={() => onSelect(trigger)}
                onOpenLog={() => onOpenLog(trigger)}
                onLogModeChange={(mode) => onLogModeChange(trigger.id || '', mode)}
              />
            ))}
          </div>
        ))}
        {scheduleTriggers.length === 0 && !isCreatingSchedule && (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            No schedule triggers yet.{' '}
            <button className="underline hover:text-foreground" onClick={onNewSchedule}>Create one</button>
          </div>
        )}
      </div>

      {/* Hook Triggers section */}
      {hookTriggers.length > 0 && (
        <div>
          <div className="sticky top-0 bg-muted/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Hook Triggers
          </div>
          {SCOPE_ORDER.filter(s => hookGrouped[s]?.length).map(scope => (
            <div key={scope}>
              <div className="sticky top-5 bg-muted/50 px-3 py-0.5 text-[10px] font-medium text-muted-foreground/70">
                {SCOPE_LABELS[scope]}
              </div>
              {hookGrouped[scope].map(trigger => (
                <TriggerListItem
                  key={trigger.id || trigger.name}
                  trigger={trigger}
                  isSelected={selectedTrigger?.id === trigger.id}
                  onSelect={() => onSelect(trigger)}
                  onOpenLog={() => onOpenLog(trigger)}
                  onLogModeChange={(mode) => onLogModeChange(trigger.id || '', mode)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
