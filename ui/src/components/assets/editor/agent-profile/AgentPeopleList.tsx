import { useQuery } from '@tanstack/react-query';
import { Trans, useLingui } from '@lingui/react/macro';
import { MessageSquare } from 'lucide-react';
import { Deployment, type AgentPerson } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';

/** One person's row: who, the machine's state, a 💬 count that opens their threads, and their cap. */
function PersonRow({ person }: { person: AgentPerson }) {
  const projectId = person.project_id;
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const id = person.deployment_typeid.replace(/^deployment-/, '');
  // A person's placement lives on the hub, not on this computer: its threads are read there.
  const { data: threads } = useQuery({
    queryKey: ['agent-person-threads', id],
    queryFn: () => Deployment.hubThreads(id),
    staleTime: 15_000,
  });
  const messages = (threads ?? []).reduce((sum, th) => sum + (th.messages ?? 0), 0);
  const machine = person.state.toLowerCase();
  const running = machine === 'ready' || machine === 'running';
  const state = running
    ? { text: t`Running`, tone: 'bg-green-500' }
    : machine === 'paused'
      ? { text: t`Paused · wakes on next message`, tone: 'bg-amber-500' }
      : machine === 'not_started'
        ? { text: t`Not started · starts on first message`, tone: 'bg-muted-foreground' }
        : { text: person.state, tone: 'bg-muted-foreground' };
  const open = () => {
    if (projectId) navigation.openDock(Deployment.projectPagePointerFor(projectId, id));
  };
  return (
    <li
      className="grid grid-cols-[1.6fr_1.4fr_auto_auto] items-center gap-3 px-3 py-2 text-sm"
      data-testid={`agent-person-${id}`}
    >
      <button type="button" className="min-w-0 truncate text-start hover:underline" onClick={open}>
        {person.who}
      </button>
      <span
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid={`agent-person-state-${id}`}
      >
        <span className={cn('size-2 rounded-full', state.tone)} />
        {state.text}
      </span>
      <button
        type="button"
        onClick={open}
        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]"
        title={t`Open their threads`}
        data-testid={`agent-person-messages-${id}`}
      >
        <MessageSquare className="size-3" />
        {messages}
      </button>
      <span className="text-end text-xs text-muted-foreground" data-testid={`agent-person-cap-${id}`}>
        {person.cap_usd_per_day != null ? t`$${person.cap_usd_per_day}/day` : t`owner default`}
      </span>
    </li>
  );
}

/**
 * A private deployment's people, on the agent's Deployments tab: one row per person who has talked to the agent,
 * each with their own machine. Read from `agent/<id>/channels` (`people`), which only the provider may read.
 */
export function AgentPeopleList({ people }: { people: AgentPerson[] }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="agent-people">
      <h3 className="text-xs font-semibold text-muted-foreground">
        <Trans>Private · one machine per person</Trans>
      </h3>
      {people.length === 0 ? (
        <span className="text-xs text-muted-foreground" data-testid="agent-people-empty">
          <Trans>Nobody has talked to it yet — each person gets their own machine on their first message.</Trans>
        </span>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {people.map((person) => (
            <PersonRow key={person.deployment_typeid} person={person} />
          ))}
        </ul>
      )}
    </div>
  );
}
