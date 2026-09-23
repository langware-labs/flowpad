import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Settings2 } from 'lucide-react';
import { AgenticProcess, Deployment, isBusy, TypeId, type Agent } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { SimpleChatPane } from '@src/components/terminal/interactive-terminal/SimpleChatPane';
import { RUN_PARAM, TRANSCRIPT_TIME_PARAM } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { AgentPlaceCard } from '../AgentPlaceCard';
import { usePlaceDisplay } from '../use-place-display';
import { useAgentPlaces } from '../use-agent-places';
import { DeploymentTimeline, eventKey } from './DeploymentTimeline';
import { useDeploymentTimeline } from './use-deployment-timeline';

/**
 * A deployment's own page, nested in its agent (`…/agent-<id>/child/deployment/deployment-<id>`):
 * the deployment's live timeline on the left — what reached it, what it ran, what it answered —
 * and, on the right, the process a selected event belongs to, its chat following the turn live.
 * Which event is selected is the URL's (`run` + `t`); nothing is selected → the newest event.
 */
export function AgentDeploymentPage({ agent, deploymentId }: { agent: Agent; deploymentId: string }) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const { data: deployment } = useEntity<Deployment>(new TypeId(Deployment.type, deploymentId));
  const { places, reload } = useAgentPlaces(agent);
  const place = places?.find((p) => p.deployment.id === deploymentId) ?? null;
  const display = usePlaceDisplay();
  const [settings, setSettings] = useState(false);
  const { events, error, hasOlder, loadOlder } = useDeploymentTimeline(deployment);

  const runParam = currentDock?.options?.[RUN_PARAM] ?? null;
  const timeParam = currentDock?.options?.[TRANSCRIPT_TIME_PARAM] ?? null;
  // Nothing chosen: the newest event that belongs to a process.
  const fallback = useMemo(() => (events ?? []).find((e) => e.process_id) ?? null, [events]);
  const processId = runParam ?? fallback?.process_id ?? null;
  const focusAt = runParam ? timeParam : null;
  const selectedKey = runParam && timeParam ? eventKey({ process_id: runParam, at: timeParam }) : fallback ? eventKey(fallback) : null;

  const select = (event: { process_id: string; at: string }) =>
    currentDock &&
    navigation.openDock(currentDock.withOption(RUN_PARAM, event.process_id).withOption(TRANSCRIPT_TIME_PARAM, event.at));

  const label = place ? display(place).label : (deployment?.name ?? '');
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-deployment-page">
      <header className="flex flex-wrap items-center gap-3 border-b px-6 py-3.5">
        <h1 className="text-lg font-semibold">{label}</h1>
        {place && <StatePill enabled={place.enabled} />}
        <span className="text-xs text-muted-foreground">
          {[agent.name, place?.overrides?.worker_type ?? agent.worker_type, place?.overrides?.model ?? agent.model]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <Button variant="outline" size="sm" className="ms-auto h-8 gap-1.5" onClick={() => setSettings((v) => !v)} aria-expanded={settings}>
          <Settings2 className="h-3.5 w-3.5" />
          {t`Settings`}
        </Button>
      </header>
      {settings && place && (
        <div className="border-b px-6 py-4">
          <AgentPlaceCard agent={agent} place={place} onChanged={reload} />
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(20rem,0.9fr)_minmax(0,1.1fr)]">
        <section className="flex min-h-0 flex-col" aria-labelledby="deployment-timeline-title">
          <header className="flex h-11 items-center border-b px-5">
            <h2 id="deployment-timeline-title" className="text-[13px] font-semibold">
              <Trans>Timeline</Trans>
            </h2>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <p className="px-5 py-6 text-sm text-destructive">{error}</p>
            ) : events === null ? null : (
              <DeploymentTimeline
                events={events}
                selectedKey={selectedKey}
                selectedProcess={processId}
                onSelect={select}
                hasOlder={hasOlder}
                onLoadOlder={() => void loadOlder()}
              />
            )}
          </div>
        </section>
        <section className="flex min-h-0 flex-col border-t lg:border-s lg:border-t-0" aria-label={t`Process`}>
          {processId ? <ProcessPane processId={processId} focusAt={focusAt} /> : <EmptyProcess />}
        </section>
      </div>
    </div>
  );
}

function StatePill({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400">
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <Trans>On</Trans>
    </span>
  ) : (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Trans>Off</Trans>
    </span>
  );
}

/** The selected process: its name and state, and its chat — live while a turn runs. */
function ProcessPane({ processId, focusAt }: { processId: string; focusAt: string | null }) {
  const { data: process } = useEntity<AgenticProcess>(new TypeId(AgenticProcess.type, processId), { watch: true });
  if (!process) return null;
  const busy = isBusy(process);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="deployment-process-pane">
      <header className="flex h-11 items-center gap-2 border-b px-5">
        <h2 className="truncate text-[13px] font-semibold">{process.name}</h2>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            busy ? 'bg-blue-500/12 text-blue-700 dark:text-blue-400' : 'bg-muted text-muted-foreground',
          )}
          data-testid="deployment-process-state"
        >
          {busy ? <Trans>Working</Trans> : <Trans>Idle</Trans>}
        </span>
      </header>
      <SimpleChatPane key={process.id} process={process} focusAt={focusAt} className="min-h-0 flex-1" />
    </div>
  );
}

function EmptyProcess() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      <Trans>Select an event to see the process that handled it.</Trans>
    </div>
  );
}
