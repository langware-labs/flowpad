import { clearPublicAccess, PUBLIC_DEPLOYER_ROLE, setPublicAccess, type Agent } from '@sdk';
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
 * their own, each funded by a public child of an LLM endpoint the owner administers, capped per visitor.
 *
 * Set up is two hub calls, in this order: `setup_visitor_deployment` (the source and the cap, which the hub
 * refuses for an agent visitors could not run) and then the `visitor` audience's `anonymous_deployer` stamp,
 * which is what lets a visitor in. The stamp goes second so it never opens an agent with no budget. It is
 * the same one stamp "Set public" writes, so it replaces a viewer stamp — which is why the role is the
 * Sharing section's (`role`/`setRole`), read once and shared with its "Set public" button. Turn off clears
 * the stamp; the stored source and cap stay, ready for the next Set up.
 */
export function AgentVisitorDeploymentSection({
  agent,
  role,
  setRole,
}: {
  agent: Agent;
  role: string | null;
  setRole: (role: string | null) => void;
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
  const open = role === PUBLIC_DEPLOYER_ROLE;

  // The only source there is: nothing to choose.
  useEffect(() => {
    if (!source && sources.length === 1) setSource(endpointTypeId(sources[0].id));
  }, [source, sources]);

  const ready = !!source && capUsd !== null && capUsd > 0;

  const handleSetup = async () => {
    if (!source || capUsd === null || capUsd <= 0) return;
    setBusy(true);
    try {
      await agent.setupVisitorDeployment({ llm_source: source, cap_usd: capUsd });
      const access = await setPublicAccess(agent.typeId, 'visitor', PUBLIC_DEPLOYER_ROLE);
      setRole(access.role ?? null);
      notify.success({
        title: t`Visitors can try this agent`,
        message: t`Anyone with the launch link gets a sandbox of their own, up to $${capUsd} each.`,
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
      const access = await clearPublicAccess(agent.typeId, 'visitor');
      setRole(access.role ?? null);
      notify.success({ title: t`Visitor trials stopped`, message: t`Only people you share with can use this agent.` });
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
        {noSources ? (
          <Trans>You administer no LLM endpoint to fund visitors from.</Trans>
        ) : (
          <Trans>
            Let anyone with the launch link try this agent in a sandbox of their own — no sign-in needed. Each visitor
            spends up to the cap, from an LLM endpoint you administer.
          </Trans>
        )}
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
          <option value="">{t`Choose an LLM source…`}</option>
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
          disabled={busy || noSources}
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
        {open && (
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
