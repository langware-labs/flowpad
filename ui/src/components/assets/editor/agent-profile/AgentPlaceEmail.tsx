import { Agent, Deployment, type AgentInboxState, type AgentPlace } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface AgentPlaceEmailProps {
  agent: Agent;
  place: AgentPlace;
  places: AgentPlace[];
  onChanged: () => void | Promise<void>;
}

/**
 * Which place answers the agent's email. Exactly one does, so replies never
 * come twice; "Answer here instead" moves it to this place.
 */
export function AgentPlaceEmail({ agent, place, places, onChanged }: AgentPlaceEmailProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [inbox, setInbox] = useState<AgentInboxState | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    agent
      .inboxState()
      .then((state) => alive && setInbox(state))
      .catch(() => alive && setInbox(null));
    return () => {
      alive = false;
    };
  }, [agent]);

  const answering = useMemo(() => places.find((p) => p.answers_email), [places]);
  const answeringName = useMemo(() => {
    if (!answering) return t`no place`;
    if (answering.is_local) return t`this computer`;
    return t`Cloud · ${new Deployment(answering.deployment as never).name}`;
  }, [answering, t]);
  const address = inbox?.inbox?.address ?? null;

  const moveHere = async () => {
    setBusy(true);
    try {
      await agent.setEmailPlace(place.deployment.id);
      await onChanged();
      notify.success({ title: t`Email is now answered here` });
    } catch (e) {
      notify.error({ title: t`Could not move email here`, message: errorMessage(e, t`Email not moved.`), forceToast: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="agent-place-email">
      {inbox === undefined ? null : address ? (
        <div className="text-sm font-medium" data-testid="agent-place-email-address">
          {address}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="agent-place-email-none">
          <Trans>This agent has no email address yet.</Trans>
        </p>
      )}
      {place.answers_email ? (
        <div className="flex items-center gap-2">
          <span
            className="rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400"
            data-testid="agent-place-email-here"
          >
            <Trans>Answered here</Trans>
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" data-testid="agent-place-email-elsewhere">
            <Trans>Answered by {answeringName}</Trans>
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void moveHere()} data-testid="agent-place-email-move">
            <Trans>Answer here instead</Trans>
          </Button>
        </div>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigation.openDock(DockPointer.forAgentInbox(agent.id))}
          data-testid="agent-place-open-inbox"
        >
          <Trans>Open inbox</Trans>
        </Button>
      </div>
    </div>
  );
}
