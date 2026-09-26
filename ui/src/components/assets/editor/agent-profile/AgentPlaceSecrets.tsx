import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  credentialsService,
  type Agent,
  type AgentReadiness,
  type Deployment,
  type DeploymentSecretsInventory,
} from '@sdk';

import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { DeploymentSecretsGate } from './DeploymentSecretsGate';

interface AgentPlaceSecretsProps {
  agent: Agent;
  deployment: Deployment;
}

const when = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleString() : '—');

/**
 * A cloud placement's secrets as the hub holds them: each value's name, when it was last written
 * and last placed on the machine, and the connections the machine may use. Names only — a value
 * never reaches this page. "Use mine" re-copies this computer's value (a rotation; the hub
 * re-places it on a running machine); Revoke takes a connection back.
 */
export function AgentPlaceSecrets({ agent, deployment }: AgentPlaceSecretsProps) {
  const { t } = useLingui();
  const [inventory, setInventory] = useState<DeploymentSecretsInventory | null>(null);
  const [readiness, setReadiness] = useState<AgentReadiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [held, ready] = await Promise.all([deployment.secretsInventory(), agent.readiness(deployment.id)]);
    setInventory(held);
    setReadiness(ready);
  }, [agent, deployment]);

  useEffect(() => {
    load().catch((e) =>
      notify.error({ title: t`Could not read this machine's secrets`, message: errorMessage(e, ''), forceToast: true }),
    );
  }, [load, t]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await run();
      await load();
    } catch (e) {
      notify.error({ title: t`Could not change ${key}`, message: errorMessage(e, t`It failed.`), forceToast: true });
    } finally {
      setBusy(null);
    }
  };

  if (!inventory) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const small = (label: string, key: string, run: () => Promise<unknown>, testId: string) => (
    <Button
      size="sm"
      variant="outline"
      className="h-6 px-2 text-xs"
      disabled={busy !== null}
      onClick={() => void act(key, run)}
      data-testid={testId}
    >
      {busy === key && <Loader2 className="me-1 h-3 w-3 animate-spin" />}
      {label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="agent-place-secrets">
      {readiness && !readiness.ready && (
        <DeploymentSecretsGate
          agent={agent}
          environment={deployment.environment}
          readiness={readiness}
          onChange={() => void load()}
        />
      )}
      <section className="flex flex-col gap-1">
        <p className="font-medium text-muted-foreground">
          <Trans>Values the hub holds</Trans>
        </p>
        {inventory.secrets.length === 0 && (
          <p className="text-muted-foreground">
            <Trans>None yet.</Trans>
          </p>
        )}
        {inventory.secrets.map((row) => (
          <div key={row.name} className="flex items-center gap-2" data-testid={`agent-place-secret-${row.name}`}>
            <span className="font-mono">{row.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {t`written ${when(row.written)}`}
              {row.placed && ` · ${row.placed.event} ${when(row.placed.ts)}`}
            </span>
            {small(
              t`Use mine`,
              row.name,
              () => credentialsService.useMine(deployment.id, [row.name]),
              `agent-place-secret-rotate-${row.name}`,
            )}
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-1">
        <p className="font-medium text-muted-foreground">
          <Trans>Connections this machine may use</Trans>
        </p>
        {inventory.authorizations.length === 0 && (
          <p className="text-muted-foreground">
            <Trans>None.</Trans>
          </p>
        )}
        {inventory.authorizations.map((row) => (
          <div
            key={row.provider}
            className="flex items-center gap-2"
            data-testid={`agent-place-authorization-${row.provider}`}
          >
            <span className="font-mono">{row.provider}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.permissions.join(', ')}</span>
            {small(
              t`Revoke`,
              row.provider,
              () => deployment.revoke(row.provider),
              `agent-place-revoke-${row.provider}`,
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
