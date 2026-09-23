import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { CalendarClock, Plus } from 'lucide-react';
import { Agent, Trigger, type TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { describeSchedule } from '@src/components/cron-view/describe-schedule';
import {
  AgentScheduleSection,
  useAgentSchedules,
  useScheduleLabels,
} from '@src/components/assets/editor/agent-profile/AgentScheduleSection';
import { useAgentPlaces } from '@src/components/assets/editor/agent-profile/use-agent-places';
import { usePlaceDisplay } from '@src/components/assets/editor/agent-profile/use-place-display';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Empty, IconButton } from './parts';

/**
 * The agent's schedules, in the resources menu. A schedule belongs to one place (the machine it
 * runs on), so each row names its place. A row opens the schedule nested in the agent editor;
 * `+` opens this computer's schedules manager to add one.
 */
export function AgentSchedulesSection({ agentTypeId }: { agentTypeId: TypeId }) {
  const { t } = useLingui();
  const display = usePlaceDisplay();
  const { navigation, currentDock } = useDockNavigation();
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const { places: loaded } = useAgentPlaces(agent);
  const places = loaded ?? [];
  const [adding, setAdding] = useState(false);
  const { schedules, isLoading } = useAgentSchedules(agentTypeId);
  const labels = useScheduleLabels();

  const local = places.find((place) => place.is_local);
  // A schedule with no place is a legacy one of this computer.
  const placeOf = (row: Trigger) => places.find((place) => place.deployment.id === row.runs_on) ?? (!row.runs_on ? local : undefined);
  // A new schedule goes on this computer when deployed here, else the first deployment; none → nowhere to run.
  const selected = local ?? places[0];

  return (
    <>
      <NavigatorSection
        scope="agent-resources"
        id="schedules"
        label={t`Schedules`}
        isLoading={isLoading}
        itemCount={schedules.length}
        action={
          <IconButton
            icon={Plus}
            label={selected ? t`Add schedule` : t`Deploy the agent first — a schedule runs on a deployment`}
            onClick={() => selected && setAdding(true)}
            disabled={!selected}
            testId="agent-resource-add-schedule"
          />
        }
        emptyState={
          <Empty>
            <Trans>Run this agent on its own, at a time you pick</Trans>
          </Empty>
        }
      >
        {schedules.map((row) => {
          const place = placeOf(row);
          return (
            <button
              key={row.id}
              type="button"
              // Opens nested in the agent editor (see DockPointer.child); a click only navigates.
              onClick={() => currentDock && navigation.openDock(currentDock.withChild('schedule', `${Trigger.type}-${row.id}`))}
              className={cn(
                'flex w-full items-start gap-1.5 px-3 py-1 text-start hover:bg-muted/60',
                currentDock?.child?.typeId === `${Trigger.type}-${row.id}` && 'bg-primary/5',
              )}
              title={place ? display(place).label : undefined}
              data-testid={`agent-resource-schedule-${row.id}`}
            >
              <CalendarClock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className={row.enabled ? 'truncate text-xs' : 'truncate text-xs text-muted-foreground line-through'}>
                  {row.name}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {describeSchedule(row.expr, row.sched_trigger_type, row.timezone, labels)}
                  {place ? ` · ${display(place).label}` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </NavigatorSection>

      {adding && selected && agent && (
        <Dialog open onOpenChange={setAdding}>
          <DialogContent className="max-w-xl" data-testid="agent-schedules-dialog">
            <DialogHeader>
              <DialogTitle>
                <Trans>Schedules · {display(selected).label}</Trans>
              </DialogTitle>
            </DialogHeader>
            <AgentScheduleSection
              agent={agent}
              autoLaunchPrompt={agent.auto_launch_prompt ?? ''}
              deploymentId={selected.deployment.id}
              isLocal={selected.is_local}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
