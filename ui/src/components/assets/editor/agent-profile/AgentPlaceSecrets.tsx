import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  credentialsService,
  type AgentReadiness,
  type Deployment,
  type DeploymentEnvRow,
  type DeploymentEnvSource,
  type DeploymentSecretsInventory,
  type Project,
} from '@sdk';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import { SecretValueInput } from '@src/components/credentials/SecretValueInput';

import { BusyButton, DeploymentSecretsGate } from './DeploymentSecretsGate';

interface AgentPlaceSecretsProps {
  project: Project;
  deployment: Deployment;
}

/** An audit timestamp (epoch seconds) the way the agent profile shows times. */
const when = (ts?: number) => formatTimeAgoShort(ts ? ts * 1000 : null);

/**
 * A cloud placement's environment as the hub places it: each variable with where it comes from — the agent's
 * Env, this deployment's own value overriding it, or Flowpad — and the connections the machine may use. Names
 * only — a value never reaches this page. Override sets this deployment's own value; Reset forgets it, so the
 * agent's applies again. "Use mine" copies this computer's value into this deployment (a rotation; the hub
 * re-places it on a running machine); Revoke takes a connection back.
 */
export function AgentPlaceSecrets({ project, deployment }: AgentPlaceSecretsProps) {
  const { t } = useLingui();
  const [inventory, setInventory] = useState<DeploymentSecretsInventory | null>(null);
  const [rows, setRows] = useState<DeploymentEnvRow[]>([]);
  const [overriding, setOverriding] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [readiness, setReadiness] = useState<AgentReadiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [held, ready, env] = await Promise.all([
      deployment.secretsInventory(),
      project.readiness(deployment.id, deployment.main_agent_id),
      deployment.environmentRows(),
    ]);
    setInventory(held);
    setReadiness(ready);
    // A hub that does not answer `environment` yet: what this deployment holds is its own values.
    setRows(
      env.length > 0
        ? env
        : held.secrets.map((r) => ({
            name: r.name,
            kind: 'secret' as const,
            source: 'deployment' as const,
            written: true,
          })),
    );
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

  const sourceLabel = (source: DeploymentEnvSource) =>
    source === 'agent' ? t`From the agent` : source === 'deployment' ? t`This deployment` : t`Provided by Flowpad`;

  /** This deployment's own value for `name`, through the credential that declares it (its name, when none does). */
  const override = async (name: string, value: string) => {
    const status = await credentialsService.status(project.id, deployment.id);
    const owner = status.credentials.find((c) => c.vars.some((v) => v.env_var === name));
    await credentialsService.setByName(owner?.name ?? name, { [name]: value }, project.id, deployment.id);
  };

  if (!inventory) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

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
      <section className="flex flex-col gap-1" data-testid="deployment-environment">
        <p className="font-medium text-muted-foreground">
          <Trans>Environment</Trans>
        </p>
        {rows.length === 0 && (
          <p className="text-muted-foreground">
            <Trans>None yet.</Trans>
          </p>
        )}
        {rows.map((row) => {
          const placed = inventory.secrets.find((s) => s.name === row.name)?.placed;
          return (
            <div key={row.name} className="flex flex-col gap-1" data-testid={`deployment-env-row-${row.name}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono">{row.name}</span>
                <span
                  className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
                  data-testid={`deployment-env-source-${row.name}`}
                >
                  {sourceLabel(row.source)}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {row.written ? t`set` : t`missing`}
                  {placed && ` · ${placed.event} ${when(placed.ts)}`}
                </span>
                {row.source !== 'flowpad' && (
                  <>
                    {row.kind === 'secret' &&
                      small(
                        t`Use mine`,
                        row.name,
                        () => credentialsService.useMine(deployment.id, [row.name]),
                        `agent-place-secret-rotate-${row.name}`,
                      )}
                    <BusyButton
                      label={t`Override`}
                      testId={`deployment-env-override-${row.name}`}
                      variant="outline"
                      busy={false}
                      disabled={busy !== null}
                      onClick={() => {
                        setOverriding(overriding === row.name ? null : row.name);
                        setDraft('');
                      }}
                    />
                    {row.source === 'deployment' &&
                      small(
                        t`Reset`,
                        `reset-${row.name}`,
                        () => deployment.forget(row.name),
                        `deployment-env-reset-${row.name}`,
                      )}
                  </>
                )}
              </div>
              {overriding === row.name && (
                <div className="flex items-center gap-1.5 ps-2">
                  <SecretValueInput
                    className="h-7 text-xs"
                    value={draft}
                    secret={row.kind !== 'plain'}
                    onValueChange={setDraft}
                    aria-label={t`Value of ${row.name} on this deployment`}
                    data-testid={`deployment-env-override-value-${row.name}`}
                  />
                  <BusyButton
                    label={t`Save`}
                    testId={`deployment-env-override-save-${row.name}`}
                    busy={busy === `override-${row.name}`}
                    disabled={busy !== null || !draft}
                    onClick={() =>
                      void act(`override-${row.name}`, async () => {
                        await override(row.name, draft);
                        setOverriding(null);
                        setDraft('');
                      })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
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
