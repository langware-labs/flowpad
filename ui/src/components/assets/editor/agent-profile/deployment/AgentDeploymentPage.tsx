import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Settings2 } from 'lucide-react';
import { Deployment, TypeId, type Agent, type DeploymentThread } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { TRANSCRIPT_TIME_PARAM } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AgentPlaceCard } from '../AgentPlaceCard';
import { usePlaceDisplay } from '../use-place-display';
import { useAgentPlaces } from '../use-agent-places';
import { DeploymentThreads } from './DeploymentThreads';
import { ThreadPane, type ThreadView } from './ThreadPane';
import { useDeploymentThreads } from './use-deployment-threads';

/** Which thread is open, and how (`agent` = its process's chat, opened at `t`), are the URL's. */
const THREAD_OPTION = 'conversation';
const VIEW_OPTION = 'pane';

/**
 * A deployment's own page, nested in its agent (`…/agent-<id>/child/deployment/deployment-<id>`):
 * on the left its threads — one per conversation, a whole phone call included, the active ones first
 * with what is happening in them now — and on the right the selected thread's events as they happen,
 * or the agent's side of it (its process's chat). Nothing selected → the first thread.
 */
export function AgentDeploymentPage({ agent, deploymentId }: { agent: Agent; deploymentId: string }) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const { data: deployment } = useEntity<Deployment>(new TypeId(Deployment.type, deploymentId));
  const { places, reload } = useAgentPlaces(agent);
  const place = places?.find((p) => p.deployment.id === deploymentId) ?? null;
  const display = usePlaceDisplay();
  const [settings, setSettings] = useState(false);
  const { threads, error } = useDeploymentThreads(deployment);

  const options = currentDock?.options ?? {};
  const selectedId = options[THREAD_OPTION] ?? threads?.[0]?.conversation_id ?? null;
  const selected = threads?.find((th) => th.conversation_id === selectedId) ?? null;
  const view: ThreadView = options[VIEW_OPTION] === 'agent' ? 'agent' : 'events';
  const focusAt = view === 'agent' ? (options[TRANSCRIPT_TIME_PARAM] ?? null) : null;

  const open = (thread: DeploymentThread) =>
    currentDock &&
    navigation.openDock(
      currentDock.withOption(THREAD_OPTION, thread.conversation_id).withOption(VIEW_OPTION, null).withOption(TRANSCRIPT_TIME_PARAM, null),
    );
  const setView = (next: ThreadView, at: string | null = null) =>
    currentDock &&
    selected &&
    navigation.openDock(
      currentDock
        .withOption(THREAD_OPTION, selected.conversation_id)
        .withOption(VIEW_OPTION, next === 'agent' ? 'agent' : null)
        .withOption(TRANSCRIPT_TIME_PARAM, next === 'agent' ? at : null),
    );

  const label = place ? display(place).label : (deployment?.name ?? '');
  const active = (threads ?? []).filter((th) => th.status === 'live' || th.status === 'working').length;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-deployment-page">
      <header className="flex flex-wrap items-center gap-3 border-b px-6 py-3.5">
        <h1 className="text-lg font-semibold">{label}</h1>
        {place && (
          <span
            className={
              place.enabled
                ? 'inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400'
                : 'rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
            }
          >
            {place.enabled ? <Trans>On</Trans> : <Trans>Off</Trans>}
          </span>
        )}
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
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
        <section className="flex min-h-0 flex-col" aria-labelledby="deployment-threads-title">
          <header className="flex h-11 items-center gap-2 border-b px-5">
            <h2 id="deployment-threads-title" className="text-[13px] font-semibold">
              <Trans>Threads</Trans>
            </h2>
            {active > 0 && (
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>{active} active</Trans>
              </span>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <p className="px-5 py-6 text-sm text-destructive">{error}</p>
            ) : threads === null ? null : (
              <DeploymentThreads threads={threads} selected={selected?.conversation_id ?? null} onSelect={open} />
            )}
          </div>
        </section>
        <section className="flex min-h-0 flex-col border-t lg:border-s lg:border-t-0" aria-label={t`Thread`}>
          {deployment && selected ? (
            <ThreadPane deployment={deployment} thread={selected} view={view} focusAt={focusAt} onView={setView} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              <Trans>Select a thread to see what happened in it.</Trans>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
