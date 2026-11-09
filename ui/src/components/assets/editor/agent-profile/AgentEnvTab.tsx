import { useEffect, useState } from 'react';
import { dataContext } from '@sdk';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { credentialsService, type Agent, type Project } from '@sdk';

import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';

import { BusyButton } from './DeploymentSecretsGate';
import { placedOn, type Placed, type SecretRow } from './project-secrets';
import type { AgentSecrets } from './use-agent-secrets';

interface AgentEnvTabProps {
  agent: Agent;
  /** `useAgentSecrets(agent)`, held by the editor so the tab's badge counts before the tab is opened. */
  secrets: AgentSecrets;
}

const STATUS_CLASS: Record<SecretRow['status'], string> = {
  set: 'text-emerald-700 dark:text-emerald-400',
  missing: 'text-amber-500',
  undeclared: 'text-red-500',
};

/**
 * The agent's credentials: per required Credential its variables, whether the project's hub store holds a value
 * (Set / Missing), or that the project does not declare it, and on how many of its machines the values were placed.
 * A value can be set here — write-only — never read. Shown on the hub page too.
 */
export function AgentEnvTab({ agent, secrets }: AgentEnvTabProps) {
  const { t } = useLingui();
  const hub = !dataContext.caps.localFiles;
  const { project, rows, setNames, reload } = secrets;
  const [placed, setPlaced] = useState<Record<string, Placed>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  // After a value changed: which machines get it.
  const [changed, setChanged] = useState<{ name: string; vars: string[] } | null>(null);

  useEffect(() => {
    if (!rows || rows.length === 0) return;
    let alive = true;
    void agent
      .deployments()
      .then((all) => Promise.all(all.filter((d) => !d.isLocal).map((d) => d.secretsInventory())))
      .then((inventories) => alive && setPlaced(placedOn(rows, inventories)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agent, rows]);

  if (!rows) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (!project || rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="agent-env">
        <Trans>This agent requires no credentials.</Trans>
      </p>
    );
  }

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await run();
      await reload();
    } catch (e) {
      notify.error({ title: t`Could not change ${key}`, message: errorMessage(e, t`It failed.`), forceToast: true });
    } finally {
      setBusy(null);
    }
  };

  const declare = (row: SecretRow) =>
    act(row.name, () =>
      credentialsService.save({
        scope: 'project',
        project_id: project.id,
        manifest: {
          name: row.name,
          setup: t`Set the value on the agent's Env tab.`,
          vars: Object.fromEntries(row.vars.map((v) => [v, {}])),
        },
      }),
    );

  const save = (row: SecretRow) =>
    act(row.name, async () => {
      const values = row.vars.filter((v) => (typed[v] ?? '').length > 0);
      await Promise.all(values.map((v) => project.setSecret(v, typed[v], setNames.has(v))));
      setTyped({});
      setEditing(null);
      if (values.length > 0 && (placed[row.name]?.of ?? 0) > 0) setChanged({ name: row.name, vars: values });
    });

  const copyMine = (row: SecretRow) =>
    act(row.name, async () => {
      const res = await project.secretsUseMine(row.vars);
      if (res.not_here.length > 0) {
        notify.warning({ title: t`Not on this computer`, message: res.not_here.join(', '), forceToast: true });
      }
      if (res.copied.length > 0 && (placed[row.name]?.of ?? 0) > 0) setChanged({ name: row.name, vars: res.copied });
    });

  const button = (label: string, row: SecretRow, run: () => void, testId: string, primary = false) => (
    <BusyButton
      label={label}
      testId={testId}
      variant={primary ? 'default' : 'outline'}
      busy={busy === row.name}
      disabled={busy !== null}
      onClick={run}
    />
  );

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="agent-env">
      <p
        className="text-muted-foreground"
        title={t`Owner and project admins can set values. Nobody can read a value back.`}
      >
        <Trans>Credentials this agent uses.</Trans>
      </p>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="py-1 text-start font-medium">
              <Trans>Credential</Trans>
            </th>
            <th className="py-1 text-start font-medium">
              <Trans>Variables</Trans>
            </th>
            <th className="py-1 text-start font-medium">
              <Trans>Status</Trans>
            </th>
            <th className="py-1 text-start font-medium">
              <Trans>Placed</Trans>
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const where = placed[row.name];
            return [
              <tr key={row.name} className="border-b align-top" data-testid={`agent-env-row-${row.name}`}>
                <td className="py-1.5 pe-2">
                  <div className="font-mono">{row.name}</div>
                  {row.status !== 'undeclared' && (
                    <div className="text-muted-foreground">
                      <Trans>Required by this agent · project Credential</Trans>
                    </div>
                  )}
                </td>
                <td className="py-1.5 pe-2 font-mono">{row.vars.join(', ')}</td>
                <td
                  className={cn('py-1.5 pe-2', STATUS_CLASS[row.status])}
                  data-testid={`agent-env-status-${row.name}`}
                >
                  {row.status === 'set' ? (
                    t`Set`
                  ) : row.status === 'missing' ? (
                    t`Missing`
                  ) : (
                    <span
                      title={t`${agent.name ?? ''} requires ${row.name}; this project does not declare it, so its machines start without it.`}
                    >
                      {t`⚠ Not declared`}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pe-2 text-muted-foreground" data-testid={`agent-env-placed-${row.name}`}>
                  {row.status === 'undeclared' || !where ? '—' : t`placed on ${where.on} of ${where.of}`}
                </td>
                <td className="py-1.5">
                  <div className="flex justify-end gap-1">
                    {row.status === 'undeclared'
                      ? !hub && button(t`Declare`, row, () => void declare(row), `agent-env-declare-${row.name}`, true)
                      : [
                          editing !== row.name && (
                            <span key="set">
                              {button(t`Set`, row, () => setEditing(row.name), `agent-env-set-${row.name}`, true)}
                            </span>
                          ),
                          !hub && (
                            <span key="mine">
                              {button(t`Use mine`, row, () => void copyMine(row), `agent-env-use-mine-${row.name}`)}
                            </span>
                          ),
                        ]}
                  </div>
                </td>
              </tr>,
              editing === row.name && (
                <tr key={`${row.name}-edit`}>
                  <td colSpan={5} className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {row.vars.map((v) => (
                        <label key={v} className="flex items-center gap-2">
                          <span className="font-mono">{v}</span>
                          <Input
                            type="password"
                            autoComplete="off"
                            className="h-8 w-72 font-mono text-sm"
                            title={t`Write-only: it cannot be shown again.`}
                            value={typed[v] ?? ''}
                            onChange={(e) => setTyped((prev) => ({ ...prev, [v]: e.target.value }))}
                            data-testid={`agent-env-value-${v}`}
                          />
                        </label>
                      ))}
                      {button(t`Save`, row, () => void save(row), `agent-env-save-${row.name}`, true)}
                    </div>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      {changed && (
        <MachinesDialog
          project={project}
          name={changed.name}
          vars={changed.vars}
          machines={placed[changed.name]?.of ?? 0}
          onClose={() => setChanged(null)}
        />
      )}
    </div>
  );
}

interface MachinesDialogProps {
  project: Project;
  name: string;
  vars: string[];
  machines: number;
  onClose: () => void;
}

/** A value changed: re-place it on every machine (paused ones at their next start), or only on new ones. */
export function MachinesDialog({ project, name, vars, machines, onClose }: MachinesDialogProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const pick = async (scope: 'all' | 'new') => {
    setBusy(true);
    try {
      await project.credentialsChanged(vars, scope);
      onClose();
    } catch (e) {
      notify.error({
        title: t`Could not update the machines`,
        message: errorMessage(e, t`It failed.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="agent-env-machines-dialog">
        <DialogHeader>
          <DialogTitle>{t`New value for ${name} — which machines get it?`}</DialogTitle>
          <DialogDescription>
            {t`${machines} machines have the old value. Paused ones get it when they next start.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void pick('new')} data-testid="agent-env-only-new">
            <Trans>Only new machines</Trans>
          </Button>
          <Button disabled={busy} onClick={() => void pick('all')} data-testid="agent-env-update-all">
            {t`Update all machines (${machines})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
