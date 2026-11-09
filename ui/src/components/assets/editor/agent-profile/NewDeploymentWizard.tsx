import {
  ComputeNodeSize,
  type Agent,
  type NewPublicInviteCode,
  type PublicDeploymentMode,
  type PublicDeploymentsState,
} from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ExternalLink, Link2, Loader2, Server, Ticket, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { endpointTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { useLlmEndpoints } from '@src/components/llm-endpoints/use-llm-endpoints';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { Input } from '@src/components/ui/input';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import {
  DEFAULT_CAP_USD,
  DEFAULT_MAX_DEPLOYMENTS,
  maskCode,
  openPcLink,
  turnOnPublicDeployments,
} from './AgentAutoLaunchTab';
import { useVisitorRole } from './AgentVisibilitySection';
import { defaultInviteSize, MachineSizeChips, useMachineSizeLine } from './MachineSizeChips';

type Step = 'kind' | 'settings' | 'launch' | 'code';
const STEPS: Step[] = ['kind', 'settings', 'launch'];

/**
 * New deployment, as a three-step card in the style of "Make an agent in 60 seconds": what kind, its settings,
 * launch. Invites are one setup per agent: when they are already on, the invite tiles open that deployment.
 */
export function NewDeploymentWizard({
  agent,
  onClose,
  onOpenInvite,
}: {
  agent: Agent;
  onClose: () => void;
  /** Open the agent's invite deployment (it exists already, or was just launched). */
  onOpenInvite: () => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [role] = useVisitorRole(agent, true);
  const [step, setStep] = useState<Step>('kind');
  const [mode, setMode] = useState<PublicDeploymentMode>('code');
  const [max, setMax] = useState<number | null>(DEFAULT_MAX_DEPLOYMENTS);
  const [source, setSource] = useState('');
  const [cap, setCap] = useState<number | null>(DEFAULT_CAP_USD);
  const [invites, setInvites] = useState<PublicDeploymentsState | null>(null);
  const [invitesRead, setInvitesRead] = useState(false);
  // A refused read is an answer, never "invites are off": that took an admin into a first-time setup.
  const [readError, setReadError] = useState<string | null>(null);
  const invitesOn = invitesRead ? invites?.settings?.allow_visitor_deployment === true : null;
  // The one-click code: minted the moment the tile is clicked, named on the same card.
  const [oneCode, setOneCode] = useState<NewPublicInviteCode | null>(null);
  const [oneName, setOneName] = useState('');
  const [busy, setBusy] = useState(false);
  // The size of the machine the next code opens: the agent's own size until one is picked on the tile.
  const [size, setSize] = useState(() => defaultInviteSize(agent));
  const sizeLine = useMachineSizeLine();

  // The hub's own answer: a visitor budget may be carved from any endpoint the caller may ALLOCATE from
  // (`agent._source_refusal`), which an editor can and an admin of nothing else cannot.
  const { endpoints } = useLlmEndpoints();
  const sources = useMemo(
    () => endpoints.filter((e) => e.enabled !== false && e.isAllowedAction('allocate')),
    [endpoints],
  );
  const chosenSource = source || (sources[0] ? endpointTypeId(sources[0].id) : '');

  useEffect(() => {
    let live = true;
    agent
      .publicDeployments()
      .then((s) => live && setInvites(s))
      .catch((e) => live && setReadError(errorMessage(e, t`Could not read this agent's deployments.`)))
      .finally(() => live && setInvitesRead(true));
    return () => {
      live = false;
    };
  }, [agent]);

  const deployPage = agent.deployPagePointer;
  const at = STEPS.indexOf(step);
  const link = openPcLink(agent);
  const ready = Boolean(chosenSource) && cap !== null && cap > 0;

  /** One new code on the one-machine card -- the end of every invite path. A new one replaces the shown one,
   * named first when a name was typed; the re-read refreshes the "machines left" line. */
  const showNewCode = async () => {
    const rename = oneCode && oneName.trim() ? agent.renamePublicCode(oneCode.id, oneName.trim()) : null;
    const [[minted]] = await Promise.all([agent.addPublicCodes(1, [], size), rename]);
    setOneCode(minted ?? null);
    setOneName('');
    setInvites(await agent.publicDeployments());
    setStep('code');
  };

  // Invites already on: the code tile is one click to a new code; the link tile opens the invite deployment.
  const mintOne = async () => {
    setBusy(true);
    try {
      await showNewCode();
    } catch (e) {
      notify.error({ title: t`Could not create a code`, message: errorMessage(e, t`The hub refused the change.`) });
    } finally {
      setBusy(false);
    }
  };

  const finishOne = async () => {
    setBusy(true);
    try {
      if (oneCode && oneName.trim()) await agent.renamePublicCode(oneCode.id, oneName.trim());
      onOpenInvite();
    } catch (e) {
      notify.error({ title: t`Could not name the invite`, message: errorMessage(e, t`The hub refused the change.`) });
    } finally {
      setBusy(false);
    }
  };

  // The student page with this code already in its box (a fragment: it never reaches a server or its logs).
  const openMachineUrl = link && oneCode ? `${link}#code=${encodeURIComponent(oneCode.code)}` : null;
  const inUse = invites?.deployments.length ?? 0;
  const maxAtOnce = invites?.settings?.max_deployments ?? null;

  const pick = (next: PublicDeploymentMode) => {
    if (invitesOn) return next === 'code' ? void mintOne() : onOpenInvite();
    setMode(next);
    setStep('settings');
  };

  const launch = async () => {
    setBusy(true);
    try {
      await turnOnPublicDeployments(
        agent,
        { mode, max_deployments: max, llm_source: chosenSource, cap_usd: cap as number },
        role,
      );
      if (mode === 'code') await showNewCode();
      else setStep('launch');
    } catch (e) {
      notify.error({
        title: t`Could not launch the deployment`,
        message: errorMessage(e, t`The hub refused the change.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const crumbs = [t`Kind`, t`Settings`, t`Launch`];
  const kindDone = mode === 'code' ? t`Invite codes` : t`Public link`;

  const tile = (
    Icon: typeof Ticket,
    title: string,
    sub: string,
    onClick: (() => void) | null,
    testId: string,
    disabledWhy?: string,
    // Below the click area, inside the tile: a control of its own (a button cannot hold one).
    extra?: ReactNode,
  ) => (
    <div className="flex flex-1 flex-col rounded-lg border border-border bg-background">
      <button
        type="button"
        disabled={!onClick}
        title={disabledWhy}
        onClick={onClick ?? undefined}
        className="flex flex-1 flex-col items-start gap-2 rounded-lg p-4 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        data-testid={testId}
      >
        <Icon className="h-7 w-7 shrink-0 text-primary" />
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{disabledWhy ?? sub}</span>
      </button>
      {extra && <div className="px-4 pb-4">{extra}</div>}
    </div>
  );

  return (
    <section data-testid="new-deployment-wizard" className="w-full rounded-xl border bg-card p-5 text-left shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <nav className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs" data-testid="new-deployment-crumbs">
          {step === 'code' ? (
            <>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                ✓ {t`Kind`}:<span className="text-foreground">{t`Invite code`}</span>
              </span>
              <span className="text-muted-foreground">›</span>
              <span className="font-semibold text-foreground">{t`Your code`}</span>
            </>
          ) : (
            STEPS.map((s, i) => (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-muted-foreground">›</span>}
                {i < at ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                    onClick={() => step !== 'launch' && setStep(s)}
                  >
                    ✓ {crumbs[i]}:
                    <span className="text-foreground">{i === 0 ? kindDone : t`$${cap ?? 0} per user`}</span>
                  </button>
                ) : (
                  <span className={i === at ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
                    {i + 1}. {crumbs[i]}
                  </span>
                )}
              </span>
            ))
          )}
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {step === 'code' ? (
              <Trans>Ready</Trans>
            ) : (
              <Trans>
                Step {at + 1} of {STEPS.length}
              </Trans>
            )}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={t`Close`}
            title={t`Close`}
            onClick={onClose}
            data-testid="new-deployment-close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mb-3">
        <h2 className="text-base font-semibold">
          {step === 'kind' && <Trans>New deployment — who will use it?</Trans>}
          {step === 'code' && <Trans>Here is the code — give it to one user</Trans>}
          {step === 'settings' && <Trans>Settings — how many, and who pays</Trans>}
          {step === 'launch' && <Trans>Launch — share the link</Trans>}
        </h2>
      </div>

      {step === 'kind' && readError && (
        <p className="text-sm text-destructive" data-testid="new-deployment-read-error">
          {readError}
        </p>
      )}
      {step === 'kind' &&
        !readError &&
        (invitesOn === null ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            {tile(
              Ticket,
              invitesOn ? t`Get an invite code` : t`Invite codes`,
              invitesOn ? t`One click — a new code for one user.` : t`One machine per user. You hand out the codes.`,
              () => pick('code'),
              'new-deployment-kind-code',
              undefined,
              <MachineSizeChips value={size} onChange={setSize} disabled={busy} />,
            )}
            {tile(
              Link2,
              t`Public link`,
              invitesOn
                ? t`Already on — open it to change who can open it.`
                : t`Anyone with the link gets their own machine.`,
              () => pick('link'),
              'new-deployment-kind-link',
            )}
            {tile(
              Server,
              t`Cloud machine`,
              t`One shared machine, always on.`,
              deployPage ? () => navigation.openDock(deployPage) : null,
              'new-deployment-kind-machine',
              deployPage ? undefined : t`Needs the agent's project on this hub.`,
            )}
          </div>
        ))}

      {step === 'code' && oneCode && (
        <div className="flex flex-col gap-3" data-testid="one-click-code">
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
            <span className="font-mono text-2xl font-semibold tracking-wider" data-testid="one-click-code-value">
              {oneCode.code}
            </span>
            <CopyButton
              value={oneCode.code}
              label={<Trans>Copy</Trans>}
              testId="one-click-copy"
              className="inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent"
            />
            {openMachineUrl && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                title={t`Opens the student page in a new tab with this code filled in`}
                onClick={() => window.open(openMachineUrl, '_blank', 'noopener')}
                data-testid="one-click-open-machine"
              >
                <Trans>Open machine</Trans>
                <ExternalLink className="ms-1.5 h-3.5 w-3.5" />
              </Button>
            )}
            <Input
              className="h-8 w-56 text-xs"
              placeholder={t`Name (optional)`}
              value={oneName}
              onChange={(e) => setOneName(e.target.value)}
              aria-label={t`Name for ${oneCode.code}`}
              data-testid="one-click-name"
            />
            <span className="text-xs text-muted-foreground">
              <Trans>Shown once — the hub keeps only {maskCode(oneCode.last4)}.</Trans>
            </span>
            <span className="text-xs text-muted-foreground" data-testid="one-click-size">
              {t`Machine: ${sizeLine(oneCode.machine_size ?? size)}`}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {maxAtOnce !== null ? (
              <Trans>
                They open the link and type the code. {Math.max(maxAtOnce - inUse, 0)} of {maxAtOnce} machines left.
              </Trans>
            ) : (
              <Trans>They open the link and type the code.</Trans>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void mintOne()}
              disabled={busy}
              data-testid="one-click-another"
            >
              {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              <Trans>Another code</Trans>
            </Button>
            <Button size="sm" onClick={() => void finishOne()} disabled={busy} data-testid="one-click-done">
              <Trans>Done</Trans>
            </Button>
          </div>
        </div>
      )}

      {step === 'settings' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">
                <Trans>At most machines at once</Trans>
              </span>
              <Input
                type="number"
                min={1}
                className="h-8 w-24 text-xs"
                value={max ?? ''}
                placeholder={t`no limit`}
                onChange={(e) => setMax(e.target.value === '' ? null : Number(e.target.value))}
                data-testid="new-deployment-max"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">
                <Trans>LLM source — users spend it</Trans>
              </span>
              <select
                className="h-8 w-72 rounded-md border border-input bg-background px-2 text-xs"
                value={chosenSource}
                onChange={(e) => setSource(e.target.value)}
                data-testid="new-deployment-source"
              >
                {!chosenSource && <option value="">{t`Choose the LLM endpoint users spend`}</option>}
                {sources.map((e) => (
                  <option key={e.id} value={endpointTypeId(e.id)}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">
                <Trans>$ per user</Trans>
              </span>
              <Input
                type="number"
                min={0}
                step="0.5"
                className="h-8 w-24 text-xs"
                value={cap ?? ''}
                onChange={(e) => setCap(e.target.value === '' ? null : Number(e.target.value))}
                data-testid="new-deployment-cap"
              />
            </label>
          </div>
          {sources.length === 0 && (
            <p className="text-xs text-destructive">
              <Trans>Add an LLM endpoint you administer first (LLM Endpoints): users are funded from it.</Trans>
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void launch()} disabled={busy || !ready} data-testid="new-deployment-next">
              {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              <Trans>Next</Trans>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setStep('kind')} disabled={busy}>
              <Trans>Back</Trans>
            </Button>
          </div>
        </div>
      )}

      {step === 'launch' && (
        <div className="flex flex-col gap-3">
          {link && (
            <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="new-deployment-link">
                {link}
              </span>
              <CopyButton
                value={link}
                title={t`Copy link`}
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onOpenInvite} data-testid="new-deployment-done">
              <Trans>Done</Trans>
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
