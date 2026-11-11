import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  credentialsService,
  type AgentReadiness,
  type Deployment,
  type DeploymentSecretsInventory,
  type Project,
} from '@sdk';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';

import { Input } from '@src/components/ui/input';

import { BusyButton, DeploymentSecretsGate } from './DeploymentSecretsGate';
import { overrideRows, type DeclaredCredential } from './project-secrets';

interface AgentPlaceSecretsProps {
  project: Project;
  deployment: Deployment;
}

/** An audit timestamp (epoch seconds) the way the agent profile shows times. */
const when = (ts?: number) => formatTimeAgoShort(ts ? ts * 1000 : null);

/**
 * A cloud placement's secrets as the hub holds them: each value's name, when it was last written
 * and last placed on the machine, and the connections the machine may use. Names only — a value
 * never reaches this page. "Use mine" re-copies this computer's value (a rotation; the hub
 * re-places it on a running machine); Revoke takes a connection back.
 */
export function AgentPlaceSecrets({ project, deployment }: AgentPlaceSecretsProps) {
  const { t } = useLingui();
  const [inventory, setInventory] = useState<DeploymentSecretsInventory | null>(null);
  const [readiness, setReadiness] = useState<AgentReadiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // "Override here": the credential being typed for this deployment only, and its values until saved.
  const [overriding, setOverriding] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [held, ready] = await Promise.all([
      deployment.secretsInventory(),
      project.readiness(deployment.id, deployment.main_agent_id),
    ]);
    setInventory(held);
    setReadiness(ready);
  }, [project, deployment]);

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

  // The credentials this deployment's agent requires, each on the project's value or overridden here.
  const required: DeclaredCredential[] = (readiness?.items ?? [])
    .filter((i) => i.requirement.kind === 'credential')
    .map((i) => ({ name: i.requirement.name, vars: i.vars.length > 0 ? i.vars : i.requirement.vars }));
  const overrides = overrideRows(required, inventory);

  const small = (label: string, key: string, run: () => Promise<unknown>, testId: string) => (
    <BusyButton
      label={label}
      testId={testId}
      variant="outline"
      busy={busy === key}
      disabled={busy !== null}
      onClick={() => void act(key, run)}
    />
  );

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="agent-place-secrets">
      {readiness && !readiness.ready && (
        <DeploymentSecretsGate
          project={project}
          deployment={deployment}
          readiness={readiness}
          onChange={(next) => {
            // The gate already re-asked readiness; only what the hub holds is re-read.
            setReadiness(next);
            void deployment.secretsInventory().then(setInventory);
          }}
        />
      )}
      {overrides.length > 0 && (
        <section className="flex flex-col gap-1" data-testid="agent-place-overrides">
          <p className="font-medium text-muted-foreground">
            <Trans>Credentials</Trans>
          </p>
          {overrides.map((row) => (
            <div key={row.name} className="flex flex-col gap-1" data-testid={`agent-place-override-${row.name}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono">{row.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {row.overridden ? t`Overridden here` : t`Project value`} ·{' '}
                  <span className="font-mono">{row.vars.join(', ')}</span>
                </span>
                {row.overridden
                  ? small(
                      t`Reset to project`,
                      row.name,
                      () => Promise.all(row.vars.map((v) => deployment.resetToProject(v))),
                      `agent-place-reset-${row.name}`,
                    )
                  : overriding !== row.name && (
                      <BusyButton
                        label={t`Override here`}
                        testId={`agent-place-override-open-${row.name}`}
                        variant="outline"
                        busy={false}
                        disabled={busy !== null}
                        onClick={() => setOverriding(row.name)}
                      />
                    )}
              </div>
              {overriding === row.name && (
                <div className="flex flex-wrap items-center gap-2">
                  {row.vars.map((v) => (
                    <Input
                      key={v}
                      type="password"
                      autoComplete="off"
                      className="h-7 w-64 font-mono text-xs"
                      placeholder={v}
                      aria-label={v}
                      title={t`Write-only: it cannot be shown again.`}
                      value={typed[v] ?? ''}
                      onChange={(e) => setTyped((prev) => ({ ...prev, [v]: e.target.value }))}
                      data-testid={`agent-place-override-value-${v}`}
                    />
                  ))}
                  {small(
                    t`Save`,
                    row.name,
                    async () => {
                      const held = new Set(inventory.secrets.map((x) => x.name));
                      const values = row.vars.filter((v) => (typed[v] ?? '').length > 0);
                      await Promise.all(values.map((v) => deployment.setOverride(v, typed[v], held.has(v))));
                      setTyped({});
                      setOverriding(null);
                    },
                    `agent-place-override-save-${row.name}`,
                  )}
                </div>
              )}
            </div>
          ))}
        </section>
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
