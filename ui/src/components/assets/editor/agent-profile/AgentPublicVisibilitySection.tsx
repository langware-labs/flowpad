import { ActionInfo, Agent, cloudManager, dataManager, TypeId, type AgentVersionState } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';
import { Globe, Loader2 } from 'lucide-react';

import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { ShareButton } from '@src/components/entity-actions/ShareButton';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { genericEntityShareSource } from '@src/hooks/share-sources';

/**
 * The one-click "launch a new sandbox running this agent" link — the same
 * `/launch?agent=<id>` landing page a shared invite would open (see
 * `ui/src/pages/entry/AgentLaunchLanding.tsx`).
 *
 * `/launch` is served by the HUB's own app origin, not this computer's local backend —
 * `ActionInfo.fullActionUrl` (as `sandboxShareLink` uses) would give the wrong one here,
 * since desk mode talks to a local backend that merely reflects to the hub. `cloudAppUrl`
 * is the real per-account hub origin (dev/staging/prod), read live off `cloud/status` —
 * never hardcoded — and correct even when this page is itself viewed ON the hub (it then
 * resolves to the hub's own browser origin, which is still the hub).
 */
export function agentLaunchLink(agent: Agent): string | null {
  const hubUrl = cloudManager.cloudAppUrl;
  if (!hubUrl) return null;
  return `${hubUrl.replace(/\/+$/, '')}/launch?agent=${encodeURIComponent(agent.id)}`;
}

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
export function AgentPublicVisibilitySection({
  agent,
  version,
}: {
  agent: Agent;
  version: AgentVersionState | null;
}) {
  const { t } = useLingui();
  // `version.published` (freshly fetched) is the gate, not the WS-stale `agent.remote`/`origin`
  // (publish() saves those with notify=False — see flow_sdk/builtin/asset_publishing.py).
  const publishable = version?.published === true;
  const launchLink = publishable ? agentLaunchLink(agent) : null;
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // Targeted sharing (pick specific people) is independent of the public-visibility
  // toggle above — a private agent can still be shared with named recipients via the
  // same contact-first dialog every other entity uses. A fresh source per open resets
  // its resolve-once prep cache.
  const shareSource = useMemo(
    () => genericEntityShareSource(new TypeId(Agent.type, agent.id), { label: agent.name }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.id, agent.name, shareOpen],
  );

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
    // `publishable` already changes whenever `version` does — no need to also list `version`.
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
      <div className="flex items-center gap-2">
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
        <ShareButton
          variant="compact"
          onClick={() => setShareOpen(true)}
          tooltip={t`Share this agent with specific people`}
          testId="agent-share-with-people"
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground" data-testid="agent-public-consequence">
        <Trans>
          Anyone, even without signing in, can see this agent's name, description and system prompt — its files and
          actions stay private.
        </Trans>
      </p>
      {launchLink && (
        <div className="mt-3" data-testid="agent-launch-link">
          <p className="mb-1 text-xs text-muted-foreground">
            <Trans>Launch a new sandbox running this agent</Trans>
          </p>
          <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{launchLink}</span>
            <CopyButton
              value={launchLink}
              testId="agent-launch-link-copy"
              title={t`Copy launch link`}
              copiedIconClassName="text-green-500"
              className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            />
          </div>
        </div>
      )}
      {shareOpen && (
        <ShareToConversationDialog open={shareOpen} onClose={() => setShareOpen(false)} source={shareSource} />
      )}
    </section>
  );
}
