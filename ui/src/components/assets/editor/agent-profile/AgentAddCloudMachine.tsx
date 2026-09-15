import { Agent } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Cloud, Loader2 } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';

import { AgentDeployChecklist } from './AgentDeployChecklist';

interface AgentAddCloudMachineProps {
  agent: Agent;
  onClose: () => void;
  /** Called with the new machine's Deployment id, so the caller can show it. */
  onDeployed: (deploymentId?: string) => void | Promise<void>;
}

/** Opened by Deploy: the prerequisites, then a cloud machine that logs in as the agent. */
export function AgentAddCloudMachine({ agent, onClose, onDeployed }: AgentAddCloudMachineProps) {
  const { t } = useLingui();
  const [deploying, setDeploying] = useState(false);
  // Tri-state from the checklist: `null` (still checking) never disables Deploy.
  const [ready, setReady] = useState<boolean | null>(null);

  const deploy = async () => {
    setDeploying(true);
    try {
      const data = await agent.deploy();
      if (data.agent_definition_error) {
        notify.warning({ title: t`Deployed without its definition`, message: data.agent_definition_error });
      } else if (data.reused) {
        notify.info({ title: t`${agent.name} already has a cloud machine` });
      } else {
        notify.success({ title: t`${agent.name} now runs on a cloud machine` });
      }
      onClose();
      await onDeployed(data.deployment?.id);
    } catch (e) {
      notify.error({
        title: t`Could not add a cloud machine`,
        message: errorMessage(e, t`Deploy failed.`),
        forceToast: true,
      });
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-dashed p-3.5"
      data-testid="agent-add-cloud-machine-panel"
    >
      <AgentDeployChecklist agent={agent} onReadinessChange={setReady} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={!agent.enabled || deploying || ready === false}
          title={ready === false ? t`Finish the setup above first` : undefined}
          onClick={() => void deploy()}
          data-testid="agent-add-cloud-machine-deploy"
        >
          {deploying ? (
            <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Cloud className="me-1.5 h-3.5 w-3.5" />
          )}
          <Trans>Deploy to a cloud machine</Trans>
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={deploying}>
          <Trans>Cancel</Trans>
        </Button>
        {deploying && (
          <span className="text-xs text-muted-foreground">
            <Trans>Starting a machine — this takes a minute.</Trans>
          </span>
        )}
      </div>
    </div>
  );
}
