import { useEffect, useState } from 'react';
import { Check, Loader2, TriangleAlert, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  credentialsService,
  type Agent,
  type AgentReadiness,
  type AgentReadinessItem,
  type Deployment,
  type Project,
} from '@sdk';

import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { deploySecretMarks } from './project-secrets';
import { useAgentSecrets } from './use-agent-secrets';

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
  /** The project the deployment places — its readiness is asked there. */
  project: Project;
  /** The placement the readiness is about — its fixes go there. */
  deployment: Deployment;
  readiness: AgentReadiness;
  onChange: (readiness: AgentReadiness) => void;
}

/**
 * What a cloud placement still lacks before its machine may start — the deploy's own refusal,
 * rendered. Each item's `remedy` says what fixes it: `use_mine` copies this computer's value into the
 * placement's store (machine → hub, never through this page), `authorize` lets the placement's
 * machine use the connection. A credential's missing value can also be typed here. Each fix re-asks readiness once, so the list is always the hub's answer.
 */
export function DeploymentSecretsGate({ project, deployment, readiness, onChange }: DeploymentSecretsGateProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState<string | null>(null);
  const [notHere, setNotHere] = useState<string[]>([]);
  // Typed here for this deployment; kept only until saved.
  const [typed, setTyped] = useState<Record<string, string>>({});

  /** A value this computer does not hold either: "Use mine" has nothing to copy. */
  const exhausted = (item: AgentReadinessItem) =>
    item.missing.length > 0 && item.missing.every((v) => notHere.includes(v));

  const fix = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    try {
      await run();
      const next = await project.readiness(deployment.id, deployment.main_agent_id);
      if (next) onChange(next);
    } catch (e) {
      notify.error({ title: t`Could not fix ${key}`, message: errorMessage(e, t`It failed.`), forceToast: true });
    } finally {
      setBusy(null);
    }
  };

  /** A credential's missing values, each with its field: the way in when this computer holds none to copy. */
  const fieldsFor = (item: AgentReadinessItem) => {
    if (item.requirement.kind !== 'credential') return null;
    const key = item.requirement.name;
    const values = Object.fromEntries(item.missing.map((name) => [name, typed[name] ?? '']));
    const save = () =>
      credentialsService.setByName(key, values, project.id, deployment.id).then(() => {
        setTyped({});
      });
    return (
      <div className="flex flex-col gap-1 ps-5">
        {item.missing.map((name) => (
          <Input
            key={name}
            type="password"
            autoComplete="off"
            className="h-7 font-mono text-xs"
            placeholder={name}
            aria-label={name}
            value={typed[name] ?? ''}
            disabled={busy !== null}
            onChange={(e) => setTyped((prev) => ({ ...prev, [name]: e.target.value }))}
            data-testid={`deployment-secret-value-${name}`}
          />
        ))}
        {item.missing.some((name) => typed[name]) && (
          <BusyButton
            label={t`Save`}
            testId={`deployment-secret-save-${key}`}
            busy={busy === key}
            disabled={busy !== null}
            onClick={() => void fix(key, save)}
          />
        )}
      </div>
    );
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
        // Model funding is advisory: the deploy goes ahead without it, so it reads as a warning, not a block.
        const advisory = missing && item.requirement.kind === 'funding';
        const key = item.requirement.name;
        return (
          <div key={`${item.requirement.kind}:${key}`} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs" data-testid={`deployment-secret-${key}`}>
              {advisory ? (
                <TriangleAlert
                  className="h-3.5 w-3.5 text-amber-500"
                  data-testid={`deployment-secret-warning-${key}`}
                />
              ) : missing ? (
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
            {missing && fieldsFor(item)}
          </div>
        );
      })}
    </div>
  );
}

interface DeploySecretsLineProps {
  agent: Agent;
  /** How many required credentials have no value in the project yet: a deploy goes ahead, warned. */
  onMissing?: (missing: number) => void;
}

/**
 * The deploy dialog's one Secrets line: each credential the agent requires, ✓ when the project holds its value,
 * ⚠ missing when not. Never a refusal — a value set later reaches the machines then.
 */
export function DeploySecretsLine({ agent, onMissing }: DeploySecretsLineProps) {
  const { t } = useLingui();
  const { rows } = useAgentSecrets(agent);
  const { marks, missing } = deploySecretMarks(rows ?? []);
  useEffect(() => {
    if (rows) onMissing?.(missing);
  }, [rows, missing, onMissing]);
  if (marks.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="new-deployment-secrets">
      <span>
        <Trans>Secrets:</Trans>
      </span>
      {marks.map((row) => (
        <span key={row.name} data-testid={`new-deployment-secret-${row.name}`}>
          <span className="font-mono">{row.name}</span>{' '}
          {row.ok ? (
            <span
              className="text-emerald-700 dark:text-emerald-400"
              title={t`From the project. Invite machines get it too — anyone with an invite code can read it on their machine.`}
            >
              ✓
            </span>
          ) : (
            <span
              className="text-amber-500"
              title={t`No value in the project yet — set it on the agent's Env tab; machines get it then.`}
            >
              {t`⚠ missing`}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
