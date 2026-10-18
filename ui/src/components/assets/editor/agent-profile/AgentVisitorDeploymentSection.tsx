import { PUBLIC_VIEWER_ROLE, setPublicAccess, type Agent } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2, Rocket } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { endpointTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/** What each visitor may spend when nobody changes it. */
const DEFAULT_CAP_USD = 2;

/**
 * "Visitor trials": let anyone with the launch link — signed out included — run this agent in a sandbox of
 * their own, optionally funded by a public child of an LLM endpoint the owner administers, capped per visitor;
 * with no endpoint chosen the visitor brings their own token source.
 *
 * Set up is `setup_visitor_deployment` with `allow_visitor_deployment: true` (which the hub refuses for an
 * agent visitors could not run), then — unless the agent is public already — the `visitor` audience's viewer
 * stamp, which is what lets a visitor reach the agent at all; it is the same one stamp "Set public" writes,
 * which is why the role is the Sharing section's (`role`/`setRole`). Turn off sends the flag false and leaves
 * the stamp: whether the agent is public stays the "Set public" button's call. The flag is known (`allowed`)
 * only once set here.
 */
export function AgentVisitorDeploymentSection({
  agent,
  role,
  setRole,
  allowed,
  setAllowed,
}: {
  agent: Agent;
  role: string | null;
  setRole: (role: string | null) => void;
  allowed: boolean | null;
  setAllowed: (allowed: boolean) => void;
}) {
  const { t } = useLingui();
  // Allocating from an endpoint takes administering it — the hub checks the same right.
  const { status, isLoading } = useLlmSources();
  const sources = useMemo(
    () => (status?.available ?? []).filter((e) => e.kind === 'hub' && e.can_administer === true),
    [status],
  );
  const [source, setSource] = useState('');
  const [capUsd, setCapUsd] = useState<number | null>(DEFAULT_CAP_USD);
  const [busy, setBusy] = useState(false);
  const open = role === PUBLIC_VIEWER_ROLE && allowed === true;

  // The only source there is: nothing to choose.
  useEffect(() => {
    if (!source && sources.length === 1) setSource(endpointTypeId(sources[0].id));
  }, [source, sources]);

  // No source: the visitor brings their own token source, so there is no cap to set.
  const ready = !source || (capUsd !== null && capUsd > 0);

  const handleSetup = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const setup = await agent.setupVisitorDeployment(
        source
          ? { allow_visitor_deployment: true, llm_source: source, cap_usd: capUsd }
          : { allow_visitor_deployment: true },
      );
      setAllowed(setup.allow_visitor_deployment);
      if (role !== PUBLIC_VIEWER_ROLE) {
        const access = await setPublicAccess(agent.typeId, 'visitor', PUBLIC_VIEWER_ROLE);
        setRole(access.role ?? null);
      }
      notify.success({
        title: t`Visitors can try this agent`,
        message: source
          ? t`Anyone with the launch link gets a sandbox of their own, up to $${capUsd} each.`
          : t`Anyone with the launch link gets a sandbox of their own, using their own LLM access.`,
      });
    } catch (e) {
      notify.error({
        title: t`Could not let visitors try this agent`,
        message: errorMessage(e, t`The hub refused the change.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleTurnOff = async () => {
    setBusy(true);
    try {
      const setup = await agent.setupVisitorDeployment({ allow_visitor_deployment: false });
      setAllowed(setup.allow_visitor_deployment);
      notify.success({
        title: t`Visitor trials stopped`,
        message: t`Visitors can no longer start a sandbox of this agent.`,
      });
    } catch (e) {
      notify.error({
        title: t`Could not stop visitor trials`,
        message: errorMessage(e, t`The hub refused the change.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const noSources = !isLoading && sources.length === 0;

  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="agent-visitor-deployment">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">
          <Trans>Visitor trials</Trans>
        </p>
        {open && (
          <span className="text-xs text-muted-foreground" data-testid="agent-visitor-deployment-on">
            <Trans>On — anyone with the launch link can try it</Trans>
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>
          Let anyone with the launch link try this agent in a sandbox of their own — no sign-in needed. Fund them from
          an LLM endpoint you administer, up to a cap each, or let them bring their own LLM access.
        </Trans>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          value={source}
          disabled={busy || noSources}
          onChange={(e) => setSource(e.target.value)}
          aria-label={t`Visitor LLM source`}
          data-testid="agent-visitor-deployment-source"
        >
          <option value="">{t`No budget — visitors bring their own`}</option>
          {sources.map((e) => (
            <option key={e.id} value={endpointTypeId(e.id)}>
              {e.name}
            </option>
          ))}
        </select>
        <Label htmlFor="agent-visitor-deployment-cap" className="text-xs">
          <Trans>$ per visitor</Trans>
        </Label>
        <Input
          id="agent-visitor-deployment-cap"
          type="number"
          min={0}
          step="0.5"
          className="h-8 w-24 text-xs"
          value={capUsd ?? ''}
          disabled={busy || !source}
          onChange={(e) => setCapUsd(e.target.value === '' ? null : Number(e.target.value))}
          data-testid="agent-visitor-deployment-cap"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleSetup()}
          disabled={busy || !ready}
          data-testid="agent-visitor-deployment-setup"
        >
          {busy ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" /> : <Rocket className="me-1.5 h-3.5 w-3.5" />}
          {open ? <Trans>Update</Trans> : <Trans>Set up</Trans>}
        </Button>
        {(open || (role === PUBLIC_VIEWER_ROLE && allowed === null)) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleTurnOff()}
            disabled={busy}
            data-testid="agent-visitor-deployment-off"
          >
            <Trans>Turn off</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}
