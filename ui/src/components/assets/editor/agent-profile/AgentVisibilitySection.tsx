import { Agent, cloudManager, type AgentVersionState } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';

import { CopyButton } from '@src/components/ui/copy-button';
import { ShareButton } from '@src/components/entity-actions/ShareButton';

import { ShareAgentDialog } from './ShareAgentDialog';

/**
 * The "launch a new sandbox running this agent" link (`<hub>/launch?agent=<id>`).
 *
 * `/launch` is served by the hub's app origin, not this computer's local backend, so the
 * origin is `cloudAppUrl` — the account's hub (dev/staging/prod), read off `cloud/status`.
 */
export function agentLaunchLink(agent: Agent): string | null {
  const hubUrl = cloudManager.cloudAppUrl;
  if (!hubUrl) return null;
  return `${hubUrl.replace(/\/+$/, '')}/launch?agent=${encodeURIComponent(agent.id)}`;
}

/**
 * Share the agent by email (a hub role on the agent) and, once published, its launch link.
 * Both need the agent on the hub: the invite is only reflected there for a published row.
 */
export function AgentVisibilitySection({ agent, version }: { agent: Agent; version: AgentVersionState | null }) {
  const { t } = useLingui();
  const published = version?.published === true;
  const launchLink = published ? agentLaunchLink(agent) : null;
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <section className="mt-4 border-t pt-4" data-testid="agent-visibility">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          <Trans>Sharing</Trans>
        </h3>
        <ShareButton
          onClick={() => setShareOpen(true)}
          disabled={!published}
          tooltip={published ? t`Share this agent with specific people` : t`Publish this agent to share it`}
          testId="agent-share-with-people"
        />
      </div>
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
          <p className="mt-1 text-xs text-muted-foreground" data-testid="agent-launch-link-hint">
            <Trans>Share the agent with someone first — the link only works for people it's shared with.</Trans>
          </p>
        </div>
      )}
      <ShareAgentDialog open={shareOpen} onOpenChange={setShareOpen} agent={agent} />
    </section>
  );
}
