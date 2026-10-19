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

import { AgentPublishButton } from './AgentPublishButton';
import { AgentVisitorDeploymentSection } from './AgentVisitorDeploymentSection';
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
 * The role the `visitor` audience holds on the agent, read once for the whole section: "Set public" and
 * "Visitor trials" write the same one stamp, so each must see what the other set. null until the hub
 * reports one — an unread or unreadable grant (not the owner, or a hub without the API) shows as private.
 * Not read until `published`: the stamp lives on the hub row, which an unpublished agent does not have.
 */
function useVisitorRole(agent: Agent, published: boolean): [string | null, (role: string | null) => void] {
  const [role, setRole] = useState<string | null>(null);

  // Keyed on the id, not the entity: a re-render may hand over a fresh `Agent` for the same row.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  useEffect(() => {
    let cancelled = false;
    setRole(null);
    if (!published) return;
    getPublicAccess(agentRef.current.typeId, 'visitor')
      // A hub without the public-access API answers this path with the agent row itself — no `audience`.
      .then((access) => !cancelled && access?.audience === 'visitor' && setRole(access.role ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agent.id, published]);

  return [role, setRole];
}

/**
 * Toggle the agent's public access for the `visitor` audience: Set public when that audience holds
 * no role, Remove public access when it does (any role, the visitor-trial one included).
 */
function PublicAccessButton({
  agent,
  role,
  setRole,
}: {
  agent: Agent;
  role: string | null;
  setRole: (role: string | null) => void;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);

  const isPublic = role !== null;

  const handleClick = async () => {
    setBusy(true);
    try {
      const access = isPublic
        ? await clearPublicAccess(agent.typeId, 'visitor')
        : await setPublicAccess(agent.typeId, 'visitor', PUBLIC_VIEWER_ROLE);
      setRole(access.role ?? null);
      if (isPublic) {
        notify.success({
          title: t`Public access removed`,
          message: t`Only people you share with can view this agent.`,
        });
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
      <Icon className={`me-1.5 h-3.5 w-3.5${busy ? 'animate-spin' : ''}`} />
      {isPublic ? <Trans>Remove public access</Trans> : <Trans>Set public</Trans>}
    </Button>
  );
}

/**
 * Share the agent by email (a hub role on the agent), make it public, and, once published, its
 * launch link. All need the agent on the hub: the invite and the public grant only land on a
 * published row — so an unpublished agent is offered Publish here, the same control the deploy
 * checklist uses. `onPublished` re-reads the version that decides `published`.
 */
export function AgentVisibilitySection({
  agent,
  version,
  onPublished,
}: {
  agent: Agent;
  version: AgentVersionState | null;
  onPublished?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const published = version?.published === true;
  const launchLink = published ? agentLaunchLink(agent) : null;
  const [shareOpen, setShareOpen] = useState(false);
  const [visitorRole, setVisitorRole] = useVisitorRole(agent, published);
  // Known only once set here: the flag lives on the hub row, which this page does not read.
  const [visitorTrials, setVisitorTrials] = useState<boolean | null>(null);

  return (
    <section className="mt-4 border-t pt-4" data-testid="agent-visibility">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          <Trans>Visibility Settings</Trans>
        </h3>
        <div className="flex items-center gap-2">
          {published ? (
            <PublicAccessButton agent={agent} role={visitorRole} setRole={setVisitorRole} />
          ) : (
            // Unknown (`version` unread) is not "unpublished": nothing is offered until it is known.
            version && <AgentPublishButton agent={agent} onPublished={onPublished} testId="agent-visibility-publish" />
          )}
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
            <Trans>Launch link: opens this agent on a desktop or in a cloud sandbox</Trans>
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
            {visitorRole === PUBLIC_VIEWER_ROLE && visitorTrials ? (
              <Trans>Anyone with the link can try this agent in a sandbox of their own — no sign-in needed.</Trans>
            ) : (
              <Trans>
                Anyone its project is shared with can launch it from this link. Making the agent public lets everyone
                see it; launching still needs the project shared with them.
              </Trans>
            )}
          </p>
        </div>
      )}
      {published && (
        <AgentVisitorDeploymentSection
          agent={agent}
          role={visitorRole}
          setRole={setVisitorRole}
          allowed={visitorTrials}
          setAllowed={setVisitorTrials}
        />
      )}
      <ShareAgentDialog open={shareOpen} onOpenChange={setShareOpen} agent={agent} />
    </section>
  );
}
