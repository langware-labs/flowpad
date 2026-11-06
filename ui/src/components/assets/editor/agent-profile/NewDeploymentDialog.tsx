import {
  Agent,
  ComputeNodeSize,
  QueryRequest,
  ComputeProviderType,
  Deployment,
  type AgentReadiness,
  type AgentRequirement,
  type AgentTokenAllocation,
  type CloudDeployProvider,
  type DeploymentSourceKind,
  type IDeployment,
  type Project,
} from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Rocket } from 'lucide-react';

import { describeApiError, errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { useDeployProviders } from '@src/hooks/use-deploy-providers';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

import { AgentModeFields, DEFAULT_AGENT_MODE, type AgentModeValue } from './AgentModeFields';
import { AgentDeployChecklist } from './AgentDeployChecklist';
import { DeploymentSecretsGate } from './DeploymentSecretsGate';
import { TokenAllocationField, tokenAllocationComplete } from './TokenAllocationField';
import { AGENT_MACHINE_SIZES, MACHINE_SIZE_PRICE, MACHINE_SIZE_SPECS, type MachineBilling } from './agent-vocabularies';

/** A cloud machine's credential environment when nobody names one. */
const DEFAULT_CLOUD_ENVIRONMENT = 'production';
const ENVIRONMENT_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const RESERVED_ENVIRONMENTS = new Set(['project', 'user', 'development']);
/** The pick-list row that opens a field for a name of one's own. */
const OTHER_ENVIRONMENT = '__other__';

/** What was typed, by credential; a blank field is left out, so it keeps the value already stored. */
function typedValues(needs: AgentRequirement[], typed: Record<string, string>) {
  const entries = needs.flatMap((need) => {
    const given = need.vars.filter((name) => typed[name]).map((name) => [name, typed[name]]);
    return need.kind === 'credential' && given.length ? [[need.name, Object.fromEntries(given)]] : [];
  });
  return entries.length ? (Object.fromEntries(entries) as Record<string, Record<string, string>>) : undefined;
}

/** What a deploy refused by the readiness gate carries (409 `not_ready`). */
interface NotReadyData {
  readiness?: AgentReadiness;
  deployment?: IDeployment;
}

/** The hub provider behind each billing: hourly sandboxes, or monthly always-on VMs. */
const BILLING_PROVIDER: Record<MachineBilling, CloudDeployProvider> = {
  hourly: ComputeProviderType.E2B,
  monthly: ComputeProviderType.GCP_VM,
};
const BILLINGS: MachineBilling[] = ['hourly', 'monthly'];

/** A size's plain name; its strength is the button's tooltip. */
const sizeName: Record<ComputeNodeSize, MessageDescriptor> = {
  [ComputeNodeSize.SMALL]: msg`Small`,
  [ComputeNodeSize.MEDIUM]: msg`Medium`,
  [ComputeNodeSize.LARGE]: msg`Large`,
};

/** The pick-list row for "no main agent" — a web-only deployment. */
const NO_AGENT = '__none__';
const SOURCE_KINDS: DeploymentSourceKind[] = ['commit', 'tag', 'release'];

interface NewDeploymentDialogProps {
  /** The project being deployed — the whole of it, at one source. */
  project: Project;
  /** An agent id to preset as the main agent ("Deploy this agent"); else the project's recommendation. */
  presetMainAgentId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new deployment's id once launched. */
  onLaunched: (deploymentId?: string) => void | Promise<void>;
}

/**
 * New deployment of a project — a cloud machine, in two steps: (1) how it bills and its size, with the price;
 * (2) what launching it needs: its main agent (the project's recommendation unless changed, or none), its
 * source (a commit — the project's HEAD by default — a tag or a release), the publish checklist,
 * environment, values and tokens, then Launch. Running on this computer is the Deployments page's switch.
 */
export function NewDeploymentDialog({
  project,
  presetMainAgentId,
  open,
  onOpenChange,
  onLaunched,
}: NewDeploymentDialogProps) {
  const { t } = useLingui();
  // The project's agents, for the main-agent pick-list.
  const agentsRequest = useMemo(
    () => new QueryRequest({ type: Agent.type, scope: [project.typeId], name: 'NewDeploymentDialog.agents' }),
    [project.typeId],
  );
  const { data: agents = [] } = useEntitiesQuery<Agent>(agentsRequest, { enabled: open });
  // `undefined`: not chosen yet — the preset, else the project's recommendation, once read.
  const [mainChoice, setMainChoice] = useState<string | undefined>(
    presetMainAgentId ? `${Agent.type}-${presetMainAgentId}` : undefined,
  );
  const [recommended, setRecommended] = useState<string | null>(null);
  const mainAgentId = mainChoice === undefined ? recommended : mainChoice === NO_AGENT ? null : mainChoice;
  const mainAgent = agents.find((a) => `${Agent.type}-${a.id}` === mainAgentId) ?? null;
  const [sourceKind, setSourceKind] = useState<DeploymentSourceKind>('commit');
  const [sourceRef, setSourceRef] = useState('');
  const [headCommit, setHeadCommit] = useState('');
  const [step, setStep] = useState<'machine' | 'setup'>('machine');
  const [billing, setBilling] = useState<MachineBilling>('hourly');
  const [size, setSize] = useState<ComputeNodeSize | null>(null);
  const [launching, setLaunching] = useState(false);
  // Tri-state from the checklist: `null` (still checking) never disables Launch.
  const [ready, setReady] = useState<boolean | null>(null);
  const [environment, setEnvironment] = useState(DEFAULT_CLOUD_ENVIRONMENT);
  const [environments, setEnvironments] = useState([DEFAULT_CLOUD_ENVIRONMENT]);
  const [environmentChosen, setEnvironmentChosen] = useState(false);
  const [namingEnvironment, setNamingEnvironment] = useState(false);
  // What the agent needs on a machine, by name: said before Launch rather than only in its refusal.
  const [needs, setNeeds] = useState<AgentRequirement[]>([]);
  // Typed here, sent with Launch: nothing is stored, and no row exists, until then. Blank keeps what is there.
  const [typed, setTyped] = useState<Record<string, string>>({});
  // `null`: unchecked — the deployed agent spends its owner's capped default.
  const [tokenAllocation, setTokenAllocation] = useState<AgentTokenAllocation | null>(null);
  const [agentMode, setAgentMode] = useState<AgentModeValue>(DEFAULT_AGENT_MODE);
  const environmentValid = ENVIRONMENT_RE.test(environment) && !RESERVED_ENVIRONMENTS.has(environment);
  // The deploy's own refusal (409 `not_ready`): what that placement's machine still lacks. Never
  // asked ahead of a Launch — planning mints the hub's row for an environment, so it waits for one.
  const [refused, setRefused] = useState<{ readiness: AgentReadiness; deployment: Deployment } | null>(null);
  // The hub publishes which providers a deployment may use; only their billings are offered.
  const { providers, isLoading: providersLoading } = useDeployProviders();
  const billings = BILLINGS.filter((b) => providers.includes(BILLING_PROVIDER[b]));
  const shownBilling = billings.includes(billing) ? billing : (billings[0] ?? billing);
  const machine = size ? { provider: BILLING_PROVIDER[shownBilling], size } : null;
  const cloud = step === 'setup' && machine !== null;
  const price = size ? MACHINE_SIZE_PRICE[shownBilling][size] : null;

  useEffect(() => {
    if (!cloud) return;
    let alive = true;
    // Neither answer is needed to deploy: without them the defaults above stand.
    void project
      .deployDefaults()
      .then((defaults) => {
        if (!alive) return;
        setEnvironments(defaults.environments);
        setEnvironment((current) => (environmentChosen ? current : defaults.environment));
        setRecommended(defaults.main_agent_id ?? null);
        setHeadCommit(defaults.source_ref ?? '');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project, cloud, environmentChosen]);

  // What the machine needs follows the main agent: the project's credentials plus that agent's.
  useEffect(() => {
    if (!cloud) return;
    let alive = true;
    void project
      .requirements(mainAgentId)
      .then((wanted) => alive && setNeeds(wanted.filter((r) => r.kind !== 'funding')))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project, cloud, mainAgentId]);

  const chooseEnvironment = (next: string) => {
    setEnvironmentChosen(true);
    setRefused(null);
    setNamingEnvironment(next === OTHER_ENVIRONMENT);
    if (next !== OTHER_ENVIRONMENT) setEnvironment(next);
  };

  const launch = async () => {
    setLaunching(true);
    try {
      if (!machine) return;
      // The size travels with the deploy: writing it into a definition would dirty the checkout being deployed.
      const data = await project.deploy({
        environment,
        provider: machine.provider,
        tokenAllocation,
        machineSize: machine.size,
        sourceKind,
        sourceRef: sourceRef.trim() || (sourceKind === 'commit' ? headCommit || null : null),
        mainAgentId,
        deploymentId: refused?.deployment.id,
        values: typedValues(needs, typed),
        ...(mainAgentId
          ? { agentMode: agentMode.mode, channels: agentMode.channels, idlePauseSeconds: agentMode.idleSeconds }
          : {}),
      });
      // Taken on: the machine is placed in the background, after this answer.
      notify.info({ title: t`Deployment running in the background` });
      onOpenChange(false);
      await onLaunched(data.deployment?.id ?? data.deployment_id);
    } catch (e) {
      if (describeApiError(e).code === 'not_ready') {
        // The refusal names the planned placement and what it lacks; its fixes go there.
        const data = (e as { response?: { data?: { data?: NotReadyData } } }).response?.data?.data;
        if (data?.readiness && data.deployment) {
          setRefused({ readiness: data.readiness, deployment: new Deployment(data.deployment) });
          return;
        }
      }
      notify.error({
        title: t`Could not launch the deployment`,
        message: errorMessage(e, t`Launch failed.`),
        error: e,
        forceToast: true,
      });
    } finally {
      setLaunching(false);
    }
  };

  const blocked =
    mainAgent?.enabled === false ||
    (sourceKind !== 'commit' && !sourceRef.trim()) ||
    launching ||
    !cloud ||
    ready === false ||
    !environmentValid ||
    !tokenAllocationComplete(tokenAllocation) ||
    refused?.readiness.ready === false;

  const segment = (on: boolean) =>
    cn(
      'flex-1 rounded px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
    );

  return (
    <Dialog open={open} onOpenChange={(next) => !launching && onOpenChange(next)}>
      <DialogContent className="max-w-lg" data-testid="new-deployment-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>New deployment</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="new-deployment-steps">
          <span className={cn(step === 'machine' && 'font-medium text-foreground')}>
            {step === 'setup' && size ? (
              <Trans>
                1 Machine · {t(sizeName[size])} · {price}
              </Trans>
            ) : (
              <Trans>1 Machine</Trans>
            )}
          </span>
          <ChevronRight className="h-3 w-3" />
          <span className={cn(step === 'setup' && 'font-medium text-foreground')}>
            <Trans>2 Setup</Trans>
          </span>
        </div>

        {step === 'machine' ? (
          <div className="flex flex-col gap-4" data-testid="new-deployment-machine">
            {providersLoading ? (
              <p className="text-xs text-muted-foreground" data-testid="new-deployment-providers-loading">
                <Trans>Loading cloud machines…</Trans>
              </p>
            ) : billings.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="new-deployment-no-cloud">
                <Trans>Sign in to the hub to deploy to a cloud machine.</Trans>
              </p>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Label className="w-14 text-xs text-muted-foreground">
                    <Trans>Billing</Trans>
                  </Label>
                  <div className="flex gap-1 rounded-md bg-muted p-1" role="radiogroup" aria-label={t`Billing`}>
                    {billings.map((b) => (
                      <button
                        key={b}
                        type="button"
                        role="radio"
                        aria-checked={shownBilling === b}
                        className={segment(shownBilling === b)}
                        onClick={() => {
                          setBilling(b);
                          setSize(null);
                          setRefused(null);
                        }}
                        data-testid={`new-deployment-billing-${b}`}
                      >
                        {b === 'hourly' ? <Trans>Hourly</Trans> : <Trans>Monthly</Trans>}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Label className="w-14 text-xs text-muted-foreground">
                    <Trans>Size</Trans>
                  </Label>
                  <div className="flex flex-1 gap-2" role="radiogroup" aria-label={t`Size`}>
                    {AGENT_MACHINE_SIZES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="radio"
                        aria-checked={size === s}
                        title={MACHINE_SIZE_SPECS[shownBilling][s]}
                        className={cn(
                          'flex-1 rounded-md border py-2.5 text-sm transition-colors',
                          size === s ? 'border-primary bg-primary/5' : 'hover:bg-muted/60',
                        )}
                        onClick={() => {
                          setSize(s);
                          setRefused(null);
                        }}
                        data-testid={`new-deployment-size-${s}`}
                      >
                        {t(sizeName[s])}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="text-center" data-testid="new-deployment-price">
                  {price ? (
                    <span className="text-xl font-semibold">{price}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      <Trans>Pick a size to see the price</Trans>
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {shownBilling === 'hourly' ? (
                    <Trans>Pay only while it runs.</Trans>
                  ) : (
                    <Trans>Always on · billed once a month.</Trans>
                  )}
                </p>
              </>
            )}
          </div>
        ) : (
          machine && (
            <div className="flex flex-col gap-3" data-testid="new-deployment-details">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="new-deployment-main-agent" className="text-xs">
                  <Trans>Main agent</Trans>
                </Label>
                <Select
                  value={mainAgentId ?? NO_AGENT}
                  disabled={launching}
                  onValueChange={(next) => {
                    setMainChoice(next);
                    setRefused(null);
                  }}
                >
                  <SelectTrigger
                    id="new-deployment-main-agent"
                    className="h-8 w-56 text-xs"
                    data-testid="new-deployment-main-agent"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_AGENT} className="text-xs">
                      <Trans>No agent</Trans>
                    </SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={`${Agent.type}-${a.id}`} className="text-xs">
                        {a.name}
                        {`${Agent.type}-${a.id}` === recommended ? ` · ${t`recommended`}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="basis-full text-xs text-muted-foreground">
                  <Trans>The agent that answers every call on this machine.</Trans>
                </span>
              </div>
              {mainAgentId && <AgentModeFields value={agentMode} onChange={setAgentMode} disabled={launching} />}
              <div className="flex flex-wrap items-center gap-2" data-testid="new-deployment-source">
                <Label htmlFor="new-deployment-source-kind" className="text-xs">
                  <Trans>Source</Trans>
                </Label>
                <Select
                  value={sourceKind}
                  disabled={launching}
                  onValueChange={(next) => setSourceKind(next as DeploymentSourceKind)}
                >
                  <SelectTrigger
                    id="new-deployment-source-kind"
                    className="h-8 w-28 text-xs"
                    data-testid="new-deployment-source-kind"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind} className="text-xs">
                        {kind === 'commit' ? t`Commit` : kind === 'tag' ? t`Tag` : t`Release`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="h-8 w-44 font-mono text-xs"
                  value={sourceRef}
                  placeholder={sourceKind === 'commit' ? headCommit.slice(0, 12) || 'HEAD' : ''}
                  aria-label={t`Source`}
                  disabled={launching}
                  onChange={(e) => setSourceRef(e.target.value)}
                  data-testid="new-deployment-source-ref"
                />
              </div>
              <AgentDeployChecklist project={project} agent={mainAgent} onReadinessChange={setReady} />
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="new-deployment-environment" className="text-xs">
                  <Trans>Environment</Trans>
                </Label>
                <Select
                  value={namingEnvironment ? OTHER_ENVIRONMENT : environment}
                  disabled={launching}
                  onValueChange={chooseEnvironment}
                >
                  <SelectTrigger
                    id="new-deployment-environment"
                    className="h-8 w-40 font-mono text-xs"
                    data-testid="new-deployment-environment"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([...environments, environment])].map((name) => (
                      <SelectItem key={name} value={name} className="font-mono text-xs">
                        {name}
                      </SelectItem>
                    ))}
                    <SelectItem value={OTHER_ENVIRONMENT} className="text-xs">
                      <Trans>Another name…</Trans>
                    </SelectItem>
                  </SelectContent>
                </Select>
                {namingEnvironment && (
                  <Input
                    className="h-8 w-32 font-mono text-xs"
                    value={environment}
                    disabled={launching}
                    onChange={(e) => {
                      setEnvironment(e.target.value.trim().toLowerCase());
                      setRefused(null);
                    }}
                    aria-invalid={!environmentValid}
                    data-testid="new-deployment-environment-name"
                  />
                )}
                <span className="basis-full text-xs text-muted-foreground">
                  {environmentValid ? (
                    <Trans>
                      Which set of values the machine reads. It joins the hub you are signed in to either way.
                    </Trans>
                  ) : (
                    <Trans>Lowercase letters, digits, - and _ (not development).</Trans>
                  )}
                </span>
              </div>
              {needs.length > 0 && !refused && (
                <div className="flex flex-col gap-1" data-testid="new-deployment-needs">
                  <p className="text-xs text-muted-foreground">
                    <Trans>What the machine needs. Leave a field empty to keep the value it already has.</Trans>
                  </p>
                  {needs.flatMap((need) =>
                    need.kind === 'credential' && need.vars.length > 0
                      ? need.vars.map((name) => (
                          <Input
                            key={name}
                            type="password"
                            autoComplete="off"
                            className="h-7 font-mono text-xs"
                            placeholder={name}
                            aria-label={name}
                            value={typed[name] ?? ''}
                            disabled={launching}
                            onChange={(e) => setTyped((prev) => ({ ...prev, [name]: e.target.value }))}
                            data-testid={`new-deployment-value-${name}`}
                          />
                        ))
                      : [
                          <p key={need.name} className="font-mono text-xs text-muted-foreground">
                            {need.name}
                          </p>,
                        ],
                  )}
                </div>
              )}
              <TokenAllocationField
                project={project}
                mainAgent={mainAgent}
                environment={environment}
                provider={machine.provider}
                deploymentId={null}
                value={tokenAllocation}
                onChange={setTokenAllocation}
                disabled={launching}
              />
              {refused && (
                <DeploymentSecretsGate
                  project={project}
                  deployment={refused.deployment}
                  readiness={refused.readiness}
                  onChange={(readiness) => setRefused({ ...refused, readiness })}
                />
              )}
            </div>
          )
        )}

        <DialogFooter className="items-center gap-2 border-t pt-3">
          {step === 'machine' ? (
            <Button disabled={!size} onClick={() => setStep('setup')} data-testid="new-deployment-next">
              <Trans>Next</Trans>
              <ChevronRight className="ms-1.5 h-4 w-4" />
            </Button>
          ) : (
            <>
              {launching ? (
                <span className="me-auto text-xs text-muted-foreground" data-testid="new-deployment-starting">
                  {/* A monthly machine is a full VM: creating and enrolling it takes longer than a sandbox. */}
                  {shownBilling === 'monthly' ? (
                    <Trans>Starting a machine — this takes a couple of minutes.</Trans>
                  ) : (
                    <Trans>Starting a machine — this takes a minute.</Trans>
                  )}
                </span>
              ) : ready === false ? (
                <span className="me-auto text-xs text-muted-foreground" data-testid="new-deployment-blocked">
                  <Trans>Finish the setup above first.</Trans>
                </span>
              ) : null}
              <Button
                variant="ghost"
                disabled={launching}
                onClick={() => setStep('machine')}
                data-testid="new-deployment-back"
              >
                <ChevronLeft className="me-1.5 h-4 w-4" />
                <Trans>Back</Trans>
              </Button>
              <Button disabled={blocked} onClick={() => void launch()} data-testid="new-deployment-launch">
                {launching ? (
                  <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Rocket className="me-1.5 h-4 w-4" />
                )}
                <Trans>Launch</Trans>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
