import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { CalendarClock, Plus } from 'lucide-react';
import { Agent, Trigger, type AgentPlace, type TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { describeSchedule } from '@src/components/cron-view/describe-schedule';
import {
  AgentScheduleSection,
  useAgentSchedules,
  useScheduleLabels,
} from '@src/components/assets/editor/agent-profile/AgentScheduleSection';
import { useAgentPlaces } from '@src/components/assets/editor/agent-profile/use-agent-places';
import { usePlaceBadge, usePlaceDisplay } from '@src/components/assets/editor/agent-profile/use-place-display';
import { DockPointer } from '@src/navigation/DockPointer';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Empty, IconButton, ResourceRow } from './parts';

/**
 * The agent's schedules, in the resources menu. A schedule belongs to one place (the machine it
 * runs on), so each row names its place. A row opens the schedule nested in the agent editor;
 * `+` opens this computer's schedules manager to add one.
 */
export function AgentSchedulesSection({ agentTypeId }: { agentTypeId: TypeId }) {
  const { t } = useLingui();
  const display = usePlaceDisplay();
  const badge = usePlaceBadge();
  const { navigation, currentDock } = useDockNavigation();
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const { places: loaded } = useAgentPlaces(agent);
  const places: AgentPlace[] = loaded ?? [];
  const [adding, setAdding] = useState(false);
  const { schedules, isLoading } = useAgentSchedules(agentTypeId, places);
  const labels = useScheduleLabels();

  const local = places.find((place) => place.is_local);
  // A new schedule goes on this computer when deployed here, else the first deployment; none → nowhere to run.
  // Its form's "Runs on" picker offers the other places and Flowpad cloud.
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
          const typeId = `${Trigger.type}-${row.id}`;
          return (
            <ResourceRow
              key={row.id}
              icon={CalendarClock}
              label={row.name}
              detail={[describeSchedule(row.expr, row.sched_trigger_type, row.timezone, labels), badge(row.place).label]
                .filter(Boolean)
                .join(' · ')}
              muted={!row.enabled}
              selected={currentDock?.child?.typeId === typeId}
              // Opens nested in the agent editor (see DockPointer.child); a hub row is not in this machine's store,
              // so it opens on the Automations screen. A click only navigates.
              onOpen={() =>
                row.source === 'hub'
                  ? navigation.openDock(DockPointer.forAutomations({ trigger: row.id }))
                  : currentDock && navigation.openDock(currentDock.withChild('schedule', typeId))
              }
              testId={`agent-resource-schedule-${row.id}`}
            />
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
