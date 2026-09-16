import { ActionInfo, Agent, dataManager } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Globe, Loader2 } from 'lucide-react';

import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { Button } from '@src/components/ui/button';

/**
 * Stamp the agent readable by anyone, signed-out callers included: the hub's `set_public`
 * with `anonymous`, which sets `visitor_role = anonymous_viewer` on the row.
 *
 * `hubReflect`: `set_public` exists only on the hub, and the agent row it stamps is the hub's.
 * In desk mode the local backend forwards the call instead of resolving it itself — the same
 * seam the membership and role actions on `APIEntity` use.
 */
export async function makeAgentPublic(agent: Agent): Promise<void> {
  const info = new ActionInfo('set_public', Agent.type, agent.id, 'POST');
  info.hubReflect = true;
  info.bodyParameters = { public: 'anonymous' };
  await dataManager.callAction<{ public: string }, unknown>(info);
}

/**
 * "Make agent publicly visible" — one way, on purpose: this is the button, not a visibility picker.
 *
 * The hub's `agent.anonymous_viewer` role grants `read` and nothing else, so the consequence line
 * names exactly what that exposes (the row: name, description, prompt) and what it does not.
 */
export function AgentPublicVisibilitySection({ agent }: { agent: Agent }) {
  const { t } = useLingui();
  // Only a published (`remote`) agent has a hub row to stamp. Whether that row is public is its
  // `visitor_role`, which the hub reports only as `expand.roles` — never on the local copy.
  const publishable = agent.remote === true;
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!publishable) return;
    let live = true;
    agent
      .fetchPermissions()
      .then((roles) => {
        if (live && roles.includes('anonymous_viewer')) setIsPublic(true);
      })
      .catch(() => {}); // unknown stays "not public": the button is still the way to make it so
    return () => {
      live = false;
    };
  }, [agent, publishable]);

  const onMakePublic = async () => {
    setBusy(true);
    try {
      await makeAgentPublic(agent);
      setIsPublic(true);
    } catch (e) {
      notify.error({
        title: t`Could not make this agent public`,
        message: errorMessage(e, t`Try again.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-4 border-t pt-4" data-testid="agent-public-visibility">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || isPublic || !publishable}
        onClick={() => void onMakePublic()}
        data-testid="agent-make-public"
      >
        {busy ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" /> : <Globe className="me-1.5 h-3.5 w-3.5" />}
        {!publishable ? (
          <Trans>Publish this agent to share it</Trans>
        ) : isPublic ? (
          <Trans>Agent is publicly visible</Trans>
        ) : (
          <Trans>Make agent publicly visible</Trans>
        )}
      </Button>
      <p className="mt-1.5 text-xs text-muted-foreground" data-testid="agent-public-consequence">
        <Trans>
          Anyone, even without signing in, can see this agent's name, description and system prompt — its files and
          actions stay private.
        </Trans>
      </p>
    </section>
  );
}
