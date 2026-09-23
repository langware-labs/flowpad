import { Agent } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Cloud, Laptop, Loader2, Rocket } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';

import { AgentDeployChecklist } from './AgentDeployChecklist';
import { AGENT_MACHINE_SIZE_LABELS, AGENT_MACHINE_SIZES } from './agent-vocabularies';

/** A cloud machine's credential environment when nobody names one. */
const DEFAULT_CLOUD_ENVIRONMENT = 'production';
const ENVIRONMENT_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const RESERVED_ENVIRONMENTS = new Set(['project', 'user', 'development']);

/** `local`, or a cloud machine size (`sm` | `md` | `lg`). */
type DeploymentType = 'local' | (typeof AGENT_MACHINE_SIZES)[number];

interface NewDeploymentDialogProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** This computer already runs the agent — it cannot be launched twice. */
  hasLocal: boolean;
  /** Saves the cloud machine size into agent.json (the hub sizes the box from it). Resolves once written. */
  onMachineSize?: (size: string) => Promise<unknown>;
  /** Called with the new deployment's id once launched. */
  onLaunched: (deploymentId?: string) => void | Promise<void>;
}

/**
 * New deployment: pick where the agent runs — this computer, or a cloud machine of a size — see
 * what launching that type needs, and Launch. Only a cloud machine needs the publish checklist
 * (it runs the published definition) and a credential environment; this computer needs neither.
 */
export function NewDeploymentDialog({ agent, open, onOpenChange, hasLocal, onMachineSize, onLaunched }: NewDeploymentDialogProps) {
  const { t } = useLingui();
  const [type, setType] = useState<DeploymentType>(hasLocal ? AGENT_MACHINE_SIZES[0] : 'local');
  const [launching, setLaunching] = useState(false);
  // Tri-state from the checklist: `null` (still checking) never disables Launch.
  const [ready, setReady] = useState<boolean | null>(null);
  const [environment, setEnvironment] = useState(DEFAULT_CLOUD_ENVIRONMENT);
  const environmentValid = ENVIRONMENT_RE.test(environment) && !RESERVED_ENVIRONMENTS.has(environment);
  const cloud = type !== 'local';

  const choices: { value: DeploymentType; label: string; hint: string; Icon: typeof Cloud; disabled?: boolean }[] = [
    {
      value: 'local',
      label: t`This computer`,
      hint: hasLocal ? t`Already deployed here` : t`Free · runs while this computer is awake`,
      Icon: Laptop,
      disabled: hasLocal,
    },
    ...AGENT_MACHINE_SIZES.map((size) => ({
      value: size,
      label: t`Cloud machine`,
      hint: AGENT_MACHINE_SIZE_LABELS[size],
      Icon: Cloud,
    })),
  ];

  const launch = async () => {
    setLaunching(true);
    try {
      let data;
      if (!cloud) {
        data = await agent.deploy(undefined, 'local');
        notify.success({ title: t`${agent.name} now runs on this computer` });
      } else {
        // The hub sizes the box from the PUBLISHED definition, so the size is written before the deploy publishes.
        await onMachineSize?.(type);
        data = await agent.deploy(environment);
        if (data.agent_definition_error) {
          notify.warning({ title: t`Deployed without its definition`, message: data.agent_definition_error });
        } else if (data.reused) {
          notify.info({ title: t`${agent.name} already has a cloud machine` });
        } else {
          notify.success({ title: t`${agent.name} now runs on a cloud machine` });
        }
      }
      onOpenChange(false);
      await onLaunched(data.deployment?.id);
    } catch (e) {
      notify.error({
        title: t`Could not launch the deployment`,
        message: errorMessage(e, t`Launch failed.`),
        forceToast: true,
      });
    } finally {
      setLaunching(false);
    }
  };

  const blocked = !agent.enabled || launching || (cloud && (ready === false || !environmentValid));

  return (
    <Dialog open={open} onOpenChange={(next) => !launching && onOpenChange(next)}>
      <DialogContent className="max-w-lg" data-testid="new-deployment-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>New deployment</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t`Deployment type`}>
          {choices.map(({ value, label, hint, Icon, disabled }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={type === value}
              disabled={disabled || launching}
              onClick={() => setType(value)}
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
        </div>

        <div className="flex flex-col gap-3 border-t pt-3" data-testid="new-deployment-details">
          {cloud ? (
            <>
              <AgentDeployChecklist agent={agent} onReadinessChange={setReady} />
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="new-deployment-environment" className="text-xs">
                  <Trans>Environment</Trans>
                </Label>
                <Input
                  id="new-deployment-environment"
                  className="h-8 w-40 font-mono text-xs"
                  value={environment}
                  disabled={launching}
                  onChange={(e) => setEnvironment(e.target.value.trim().toLowerCase())}
                  aria-invalid={!environmentValid}
                  data-testid="new-deployment-environment"
                />
                <span className="text-xs text-muted-foreground">
                  {environmentValid ? (
                    <Trans>The machine reads this environment's credentials.</Trans>
                  ) : (
                    <Trans>Lowercase letters, digits, - and _ (not development).</Trans>
                  )}
                </span>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="new-deployment-local-details">
              <Trans>Runs on this computer with your own credentials, only while it is awake. Nothing is published.</Trans>
            </p>
          )}
        </div>

        <DialogFooter className="items-center gap-2">
          {launching && cloud && (
            <span className="me-auto text-xs text-muted-foreground">
              <Trans>Starting a machine — this takes a minute.</Trans>
            </span>
          )}
          <Button
            disabled={blocked}
            title={cloud && ready === false ? t`Finish the setup above first` : undefined}
            onClick={() => void launch()}
            data-testid="new-deployment-launch"
          >
            {launching ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Rocket className="me-1.5 h-4 w-4" />}
            <Trans>Launch</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
