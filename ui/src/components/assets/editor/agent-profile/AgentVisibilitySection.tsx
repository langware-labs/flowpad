import {
  Agent,
  clearPublicAccess,
  cloudManager,
  getPublicAccess,
  PUBLIC_VIEWER_ROLE,
  setPublicAccess,
  type AgentVersionState,
} from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Globe, GlobeLock, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { ShareButton } from '@src/components/entity-actions/ShareButton';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

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
 * Toggle the agent's public access for the `visitor` audience: Set public when that audience holds
 * no role, Remove public access when it does. The role is read on mount; until the hub reports one
 * — or when it cannot (not the owner, or a hub without the API) — the agent is shown as private.
 */
function PublicAccessButton({ agent }: { agent: Agent }) {
  const { t } = useLingui();
  // null until the hub reports a role — an unread or unreadable grant shows as private.
  const [role, setRole] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keyed on the id, not the entity: a re-render may hand over a fresh `Agent` for the same row.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  useEffect(() => {
    let cancelled = false;
    setRole(null);
    getPublicAccess(agentRef.current.typeId, 'visitor')
      // A hub without the public-access API answers this path with the agent row itself — no `audience`.
      .then((access) => !cancelled && access?.audience === 'visitor' && setRole(access.role ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const isPublic = role !== null;

  const handleClick = async () => {
    setBusy(true);
    try {
      const access = isPublic
        ? await clearPublicAccess(agent.typeId, 'visitor')
        : await setPublicAccess(agent.typeId, 'visitor', PUBLIC_VIEWER_ROLE);
      setRole(access.role ?? null);
      if (isPublic) {
        notify.success({ title: t`Public access removed`, message: t`Only people you share with can view this agent.` });
      } else {
        notify.success({ title: t`Agent is public`, message: t`Anyone with the link can view this agent.` });
      }
    } catch (e) {
      notify.error({
        title: isPublic ? t`Could not remove public access` : t`Could not make the agent public`,
        message: errorMessage(e, t`The hub refused the change.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const Icon = busy ? Loader2 : isPublic ? GlobeLock : Globe;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void handleClick()}
      disabled={busy}
      title={
        isPublic
          ? t`Anyone with the link can view this agent — remove to make it private again`
          : t`Let anyone with the link view this agent — its files stay private`
      }
      data-testid="agent-public-access"
    >
      <Icon className={`me-1.5 h-3.5 w-3.5${busy ? ' animate-spin' : ''}`} />
      {isPublic ? <Trans>Remove public access</Trans> : <Trans>Set public</Trans>}
    </Button>
  );
}

/**
 * Share the agent by email (a hub role on the agent), make it public, and, once published, its
 * launch link. All need the agent on the hub: the invite and the public grant only land on a
 * published row.
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
        <div className="flex items-center gap-2">
          {published && <PublicAccessButton agent={agent} />}
          <ShareButton
            onClick={() => setShareOpen(true)}
            disabled={!published}
            tooltip={published ? t`Share this agent with specific people` : t`Publish this agent to share it`}
            testId="agent-share-with-people"
          />
        </div>
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
