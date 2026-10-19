import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { credentialsService, type Agent, type AgentReadiness, type AgentReadinessItem, type Deployment } from '@sdk';

import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

interface BusyButtonProps {
  label: string;
  testId: string;
  /** This button's own action is running. */
  busy: boolean;
  /** Some action is running: every button waits. */
  disabled: boolean;
  onClick: () => void;
  variant?: 'default' | 'outline';
}

/** A small action button that spins while its own action runs — the secrets rows' one button. */
export function BusyButton({ label, testId, busy, disabled, onClick, variant = 'default' }: BusyButtonProps) {
  return (
    <Button
      size="sm"
      variant={variant}
      className="h-6 px-2 text-xs"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {busy && <Loader2 className="me-1 h-3 w-3 animate-spin" />}
      {label}
    </Button>
  );
}

interface DeploymentSecretsGateProps {
  agent: Agent;
  /** The placement the readiness is about — its fixes go there. */
  deployment: Deployment;
  readiness: AgentReadiness;
  onChange: (readiness: AgentReadiness) => void;
}

/**
 * What a cloud placement still lacks before its machine may start — the deploy's own refusal,
 * rendered. Each item's `remedy` says what fixes it: `use_mine` copies this computer's value into the
 * placement's store (machine → hub, never through this page), `authorize` lets the placement's
 * machine use the connection. Each fix re-asks readiness once, so the list is always the hub's answer.
 */
export function DeploymentSecretsGate({ agent, deployment, readiness, onChange }: DeploymentSecretsGateProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState<string | null>(null);
  const [notHere, setNotHere] = useState<string[]>([]);

  /** A value this computer does not hold either: "Use mine" has nothing to copy. */
  const exhausted = (item: AgentReadinessItem) =>
    item.missing.length > 0 && item.missing.every((v) => notHere.includes(v));

  const fix = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    try {
      await run();
      const next = await agent.readiness(deployment.id);
      if (next) onChange(next);
    } catch (e) {
      notify.error({ title: t`Could not fix ${key}`, message: errorMessage(e, t`It failed.`), forceToast: true });
    } finally {
      setBusy(null);
    }
  };

  const actionFor = (item: AgentReadinessItem) => {
    const key = item.requirement.name;
    const button = (label: string, testId: string, run: () => Promise<void>) => (
      <BusyButton
        label={label}
        testId={testId}
        busy={busy === key}
        disabled={busy !== null}
        onClick={() => void fix(key, run)}
      />
    );
    if (item.remedy === 'use_mine' && !exhausted(item)) {
      return button(t`Use mine`, `deployment-secret-use-mine-${key}`, async () => {
        const result = await credentialsService.useMine(deployment.id, item.vars);
        setNotHere((prev) => [...new Set([...prev, ...result.not_here])]);
      });
    }
    if (item.remedy === 'authorize' && item.connection) {
      return button(t`Authorize`, `deployment-secret-authorize-${key}`, () =>
        deployment.authorize(item.connection, item.requirement.kind === 'permission' ? [key] : []),
      );
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
              {!missing ? item.where : exhausted(item) ? t`Not on this computer either — ${item.fix}` : item.fix}
            </span>
            {missing && actionFor(item)}
          </div>
        );
      })}
    </div>
  );
}
