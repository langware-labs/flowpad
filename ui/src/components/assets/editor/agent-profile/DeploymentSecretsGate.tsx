import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Deployment, credentialsService, type Agent, type AgentReadiness, type AgentReadinessItem } from '@sdk';

import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

interface DeploymentSecretsGateProps {
  agent: Agent;
  environment: string;
  /** The readiness the deploy was refused with (409 `not_ready`). */
  readiness: AgentReadiness;
  onChange: (readiness: AgentReadiness) => void;
}

/**
 * What a cloud placement still lacks before its machine may start — the deploy's own refusal,
 * rendered. A missing value is copied from this computer ("Use mine": it moves machine → hub,
 * never through this page); a connection is authorized for THIS placement's machine. Each fix
 * re-plans once (idempotent: the same hub row), so the list is always the hub's answer.
 */
export function DeploymentSecretsGate({ agent, environment, readiness, onChange }: DeploymentSecretsGateProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState<string | null>(null);
  const [notHere, setNotHere] = useState<string[]>([]);

  const fix = async (key: string, run: (deployment: Deployment) => Promise<void>) => {
    setBusy(key);
    try {
      const planned = await agent.planDeployment(environment);
      await run(new Deployment(planned.deployment));
      onChange((await agent.planDeployment(environment)).readiness);
    } catch (e) {
      notify.error({ title: t`Could not fix ${key}`, message: errorMessage(e, t`It failed.`), forceToast: true });
    } finally {
      setBusy(null);
    }
  };

  const copyMine = (item: AgentReadinessItem) =>
    fix(item.requirement.name, async (deployment) => {
      const result = await credentialsService.useMine(deployment.id, item.vars);
      setNotHere((prev) => [...new Set([...prev, ...result.not_here])]);
    });

  const authorize = (item: AgentReadinessItem) =>
    fix(item.requirement.name, (deployment) =>
      deployment.authorize(item.connection, item.requirement.kind === 'permission' ? [item.requirement.name] : []),
    );

  const actionFor = (item: AgentReadinessItem) => {
    const key = item.requirement.name;
    const button = (label: string, testId: string, run: () => void) => (
      <Button size="sm" className="h-6 px-2 text-xs" disabled={busy !== null} onClick={run} data-testid={testId}>
        {busy === key && <Loader2 className="me-1 h-3 w-3 animate-spin" />}
        {label}
      </Button>
    );
    if (item.vars.length && !item.vars.every((v) => notHere.includes(v))) {
      return button(t`Use mine`, `deployment-secret-use-mine-${key}`, () => void copyMine(item));
    }
    // Held on this computer, not yet granted to that machine: the owner's consent, per placement.
    if (item.connection && item.fix.startsWith('authorize')) {
      return button(t`Authorize`, `deployment-secret-authorize-${key}`, () => void authorize(item));
    }
    return undefined;
  };

  return (
    <div className="flex flex-col gap-1" data-testid="deployment-secrets-gate">
      <p className="text-xs font-medium text-muted-foreground">
        <Trans>What the {readiness.environment} machine still needs</Trans>
      </p>
      {readiness.items.map((item) => {
        const missing = item.status === 'missing';
        const key = item.requirement.name;
        return (
          <div
            key={`${item.requirement.kind}:${key}`}
            className="flex items-center gap-2 text-xs"
            data-testid={`deployment-secret-${key}`}
          >
            {missing ? (
              <X className="h-3.5 w-3.5 text-destructive" />
            ) : (
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            )}
            <span className="font-mono">{key}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={missing ? item.fix : item.where}>
              {missing
                ? item.vars.length && item.vars.every((v) => notHere.includes(v))
                  ? t`Not on this computer either — ${item.fix}`
                  : item.fix
                : item.where}
            </span>
            {missing && actionFor(item)}
          </div>
        );
      })}
    </div>
  );
}
