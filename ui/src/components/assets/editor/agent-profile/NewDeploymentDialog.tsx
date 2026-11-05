import {
  Agent,
  ComputeNodeSize,
  ComputeProviderType,
  Deployment,
  type AgentReadiness,
  type AgentRequirement,
  type AgentTokenAllocation,
  type CloudDeployProvider,
  type IDeployment,
} from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Cloud, Laptop, Loader2, Rocket } from 'lucide-react';

import { describeApiError, errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { useDeployProviders } from '@src/hooks/use-deploy-providers';

import { AgentDeployChecklist } from './AgentDeployChecklist';
import { DeploymentSecretsGate } from './DeploymentSecretsGate';
import { TokenAllocationField, tokenAllocationComplete } from './TokenAllocationField';
import {
  AGENT_MACHINE_SIZE_LABELS,
  AGENT_MACHINE_SIZES,
  AGENT_MONTHLY_MACHINE_SIZE_LABELS,
} from './agent-vocabularies';

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

/** A cloud machine: the hub provider it lands on and its size, e.g. `e2b-sm`. */
type CloudMachine = `${CloudDeployProvider}-${ComputeNodeSize}`;

/** `local`, or a cloud machine. */
type DeploymentType = 'local' | CloudMachine;

function cloudMachine(type: CloudMachine): { provider: CloudDeployProvider; size: ComputeNodeSize } {
  // The size is the last segment: a provider is the hub's name and may itself hold a '-'.
  const cut = type.lastIndexOf('-');
  return { provider: type.slice(0, cut), size: type.slice(cut + 1) as ComputeNodeSize };
}

/**
 * How each provider's machines read: billed hourly, or monthly with the machine's strength. A provider
 * the hub offers that is missing here still gets its rows, hinted by its bare name.
 */
const PROVIDER_HINTS: Partial<Record<CloudDeployProvider, Record<ComputeNodeSize, string>>> = {
  [ComputeProviderType.E2B]: AGENT_MACHINE_SIZE_LABELS,
  [ComputeProviderType.GCP_VM]: AGENT_MONTHLY_MACHINE_SIZE_LABELS,
};

/** The provider's short name shown on its rows; a provider missing here shows its bare hub name. */
const PROVIDER_NAMES: Partial<Record<CloudDeployProvider, string>> = {
  [ComputeProviderType.E2B]: 'e2b',
  [ComputeProviderType.GCP_VM]: 'gcp',
};

interface NewDeploymentDialogProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new deployment's id once launched. */
  onLaunched: (deploymentId?: string) => void | Promise<void>;
}

/**
 * New deployment: pick where the agent runs — this computer, or a cloud machine of a size — see
 * what launching that type needs, and Launch. Only a cloud machine needs the publish checklist
 * (it runs the published definition) and a credential environment; this computer needs neither.
 */
export function NewDeploymentDialog({ agent, open, onOpenChange, onLaunched }: NewDeploymentDialogProps) {
  const { t } = useLingui();
  const [type, setType] = useState<DeploymentType>('local');
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
  const environmentValid = ENVIRONMENT_RE.test(environment) && !RESERVED_ENVIRONMENTS.has(environment);
  // The deploy's own refusal (409 `not_ready`): what that placement's machine still lacks. Never
  // asked ahead of a Launch — planning mints the hub's row for an environment, so it waits for one.
  const [refused, setRefused] = useState<{ readiness: AgentReadiness; deployment: Deployment } | null>(null);
  const machine = type === 'local' ? null : cloudMachine(type);
  const cloud = machine !== null;
  // The hub publishes which providers a deployment may use; only those get rows.
  const { providers, isLoading: providersLoading } = useDeployProviders();
  useEffect(() => {
    for (const provider of providers) {
      if (!PROVIDER_HINTS[provider]) console.log(`[NewDeploymentDialog] no display for hub provider '${provider}'`);
    }
  }, [providers]);

  useEffect(() => {
    if (!cloud) return;
    let alive = true;
    // Neither answer is needed to deploy: without them the defaults above stand.
    void agent
      .deployDefaults()
      .then((defaults) => {
        if (!alive) return;
        setEnvironments(defaults.environments);
        setEnvironment((current) => (environmentChosen ? current : defaults.environment));
      })
      .catch(() => {});
    void agent
      .requirements()
      .then((wanted) => alive && setNeeds(wanted.filter((r) => r.kind !== 'funding')))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agent, cloud, environmentChosen]);

  const chooseEnvironment = (next: string) => {
    setEnvironmentChosen(true);
    setRefused(null);
    setNamingEnvironment(next === OTHER_ENVIRONMENT);
    if (next !== OTHER_ENVIRONMENT) setEnvironment(next);
  };

  // Every cloud row reads "Cloud machine" with the provider that runs it, e.g. "Cloud machine · e2b".
  const cloudRows = (provider: CloudDeployProvider) =>
    AGENT_MACHINE_SIZES.map((size) => ({
      value: `${provider}-${size}` satisfies CloudMachine,
      label: `${t`Cloud machine`} · ${PROVIDER_NAMES[provider] ?? provider}`,
      hint: PROVIDER_HINTS[provider]?.[size] ?? provider,
      Icon: Cloud,
    }));
  const choices: { value: DeploymentType; label: string; hint: string; Icon: typeof Cloud }[] = [
    // One more each time: every local deployment is its own process on this computer.
    { value: 'local', label: t`This computer`, hint: t`Free · runs while this computer is awake`, Icon: Laptop },
    ...providers.flatMap(cloudRows),
  ];

  const launch = async () => {
    setLaunching(true);
    try {
      let data;
      if (!machine) {
        data = await agent.deploy({ provider: 'local' });
        notify.success({ title: t`${agent.name} now runs on this computer` });
      } else {
        // The size travels with the deploy: writing it into agent.json would dirty the checkout being deployed.
        data = await agent.deploy({
          environment,
          provider: machine.provider,
          tokenAllocation,
          machineSize: machine.size,
          deploymentId: refused?.deployment.id,
          values: typedValues(needs, typed),
        });
        // Taken on: the machine is placed in the background, after this answer.
        notify.info({ title: t`Deployment running in the background` });
      }
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
    !agent.enabled ||
    launching ||
    (cloud &&
      (ready === false ||
        !environmentValid ||
        !tokenAllocationComplete(tokenAllocation) ||
        refused?.readiness.ready === false));

  return (
    <Dialog open={open} onOpenChange={(next) => !launching && onOpenChange(next)}>
      <DialogContent className="max-w-lg" data-testid="new-deployment-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>New deployment</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t`Deployment type`}>
          {choices.map(({ value, label, hint, Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={type === value}
              disabled={launching}
              onClick={() => {
                setType(value);
                setRefused(null);
              }}
              className={cn(
                'flex items-center gap-3 rounded-md border px-3 py-2 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                type === value ? 'border-primary bg-primary/5' : 'hover:bg-muted/60',
              )}
              data-testid={`new-deployment-type-${value}`}
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-sm">{label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
            </button>
          ))}
          {providersLoading ? (
            <p className="px-3 text-xs text-muted-foreground" data-testid="new-deployment-providers-loading">
              <Trans>Loading cloud machines…</Trans>
            </p>
          ) : (
            providers.length === 0 && (
              <p className="px-3 text-xs text-muted-foreground" data-testid="new-deployment-no-cloud">
                <Trans>Sign in to the hub to deploy to a cloud machine.</Trans>
              </p>
            )
          )}
        </div>

        <div className="flex flex-col gap-3 border-t pt-3" data-testid="new-deployment-details">
          {machine ? (
            <>
              <AgentDeployChecklist agent={agent} onReadinessChange={setReady} />
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
                agent={agent}
                environment={environment}
                provider={machine.provider}
                deploymentId={null}
                value={tokenAllocation}
                onChange={setTokenAllocation}
                disabled={launching}
              />
              {refused && (
                <DeploymentSecretsGate
                  agent={agent}
                  deployment={refused.deployment}
                  readiness={refused.readiness}
                  onChange={(readiness) => setRefused({ ...refused, readiness })}
                />
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="new-deployment-local-details">
              <Trans>
                Runs as a process on this computer with your own credentials, only while it is awake. Nothing is
                published.
              </Trans>
            </p>
          )}
        </div>

        <DialogFooter className="items-center gap-2">
          {launching && machine && (
            <span className="me-auto text-xs text-muted-foreground" data-testid="new-deployment-starting">
              {/* A monthly machine is a full VM: creating and enrolling it takes longer than a sandbox. */}
              {machine.provider === (ComputeProviderType.GCP_VM as string) ? (
                <Trans>Starting a machine — this takes a couple of minutes.</Trans>
              ) : (
                <Trans>Starting a machine — this takes a minute.</Trans>
              )}
            </span>
          )}
          {cloud && ready === false && !launching && (
            <span className="me-auto text-xs text-muted-foreground" data-testid="new-deployment-blocked">
              <Trans>Finish the setup above first.</Trans>
            </span>
          )}
          <Button disabled={blocked} onClick={() => void launch()} data-testid="new-deployment-launch">
            {launching ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Rocket className="me-1.5 h-4 w-4" />}
            <Trans>Launch</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
