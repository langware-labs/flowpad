import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  credentialsService,
  type Agent,
  type AgentEnv,
  type AgentEnvEntry,
  type AgentEnvEntryInput,
  type AgentEnvKind,
} from '@sdk';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Switch } from '@src/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { SecretValueInput } from '@src/components/credentials/SecretValueInput';
import { ENV_VAR_RE } from '@src/components/credentials/credential-draft';

import { BusyButton } from './DeploymentSecretsGate';

interface AgentEnvTabProps {
  agent: Agent;
}

/** A credential variable the project or the user declares, offered to approve into the Env. */
interface DeclaredVar {
  name: string;
  secret: boolean;
  credential: string;
}

const toInput = (e: AgentEnvEntry): AgentEnvEntryInput => ({
  name: e.name,
  kind: e.kind,
  description: e.description,
  inject: e.inject,
  value: e.value ?? null,
});

/**
 * The agent's Env: what every deployment of it gets. One row per variable — its kind, whether it has a value,
 * the Inject switch (the owner's approval: only an approved entry is placed) and how many placements carry it.
 * A secret's value is written to the hub and never read back; a plain value lives in agent.json. "Add variable"
 * approves one of the agent's other declared credentials into the Env. What Flowpad itself provides is listed,
 * read-only, under "Provided by Flowpad".
 */
export function AgentEnvTab({ agent }: AgentEnvTabProps) {
  const { t } = useLingui();
  const [env, setEnvState] = useState<AgentEnv | null>(null);
  const [declared, setDeclared] = useState<DeclaredVar[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<AgentEnvKind>('secret');

  const load = useCallback(async () => setEnvState(await agent.env()), [agent]);

  useEffect(() => {
    load().catch((e) =>
      notify.error({ title: t`Could not read the agent's Env`, message: errorMessage(e, ''), forceToast: true }),
    );
  }, [load, t]);

  useEffect(() => {
    credentialsService
      .status(agent.project_id ?? null)
      .then((status) =>
        setDeclared(
          status.credentials.flatMap((row) =>
            row.vars
              .filter((v) => v.kind !== 'cli' && v.kind !== 'oauth')
              .map((v) => ({ name: v.env_var, secret: v.secret, credential: row.title || row.name })),
          ),
        ),
      )
      .catch(() => setDeclared([]));
  }, [agent]);

  /** Run one action; `reload` re-reads the Env for an action whose answer is not the view. */
  const act = async (key: string, run: () => Promise<unknown>, failure: string, reload = false) => {
    setBusy(key);
    try {
      await run();
      if (reload) await load();
    } catch (e) {
      notify.error({ title: failure, message: errorMessage(e, failure), forceToast: true });
    } finally {
      setBusy(null);
    }
  };

  const entries = useMemo(() => env?.entries ?? [], [env]);
  const placements = env?.placements ?? [];
  const save = (next: AgentEnvEntryInput[]) => agent.setEnv(next).then(setEnvState);
  const replace = (name: string, change: Partial<AgentEnvEntryInput>) =>
    save(entries.map((e) => (e.name === name ? { ...toInput(e), ...change } : toInput(e))));

  const offered = [...new Map(declared.map((d) => [d.name, d] as const)).values()].filter(
    (d) => !entries.some((e) => e.name === d.name),
  );

  const add = (name: string, kind: AgentEnvKind) =>
    act(
      `add-${name}`,
      async () => {
        await save([...entries.map(toInput), { name, kind, description: '', inject: true }]);
        setAdding(false);
        setNewName('');
      },
      t`Could not add ${name}`,
    );

  const setValue = (entry: AgentEnvEntry) =>
    act(
      `set-${entry.name}`,
      async () => {
        if (entry.kind === 'secret') await agent.setEnvSecret(entry.name, draft);
        else await replace(entry.name, { value: draft });
        setEditing(null);
        setDraft('');
      },
      t`Could not set ${entry.name}`,
      entry.kind === 'secret',
    );

  const forget = (entry: AgentEnvEntry) =>
    act(
      `forget-${entry.name}`,
      async () => {
        if (entry.kind === 'secret' && entry.written) await agent.forgetEnv(entry.name);
        await save(entries.filter((e) => e.name !== entry.name).map(toInput));
      },
      t`Could not forget ${entry.name}`,
    );

  const copyMine = (entry: AgentEnvEntry) =>
    act(
      `mine-${entry.name}`,
      async () => {
        const res = await agent.envUseMine([entry.name]);
        if (res.not_here.length) notify.warning({ title: t`This computer holds no value for ${entry.name}` });
      },
      t`Could not copy ${entry.name}`,
      true,
    );

  if (!env) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const status = (e: AgentEnvEntry) => {
    if (e.written) return { label: t`Set`, className: 'text-emerald-700 dark:text-emerald-400' };
    if (e.inject) return { label: t`Missing`, className: 'text-destructive' };
    return { label: t`Not set`, className: 'text-muted-foreground' };
  };

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="agent-env">
      <p className="text-muted-foreground">
        <Trans>
          What every deployment of this agent gets. Only the variables you approve with Inject are placed on its
          machines. A secret's value is kept by Flowpad Cloud and is never shown again.
        </Trans>
      </p>
      {entries.length === 0 ? (
        <p className="text-muted-foreground" data-testid="agent-env-empty">
          <Trans>No variables yet.</Trans>
        </p>
      ) : (
        <table className="w-full border-collapse" data-testid="agent-env-table">
          <thead>
            <tr className="border-b text-start text-muted-foreground">
              <th className="py-1 text-start font-medium">{t`Name`}</th>
              <th className="py-1 text-start font-medium">{t`Kind`}</th>
              <th className="py-1 text-start font-medium">{t`Status`}</th>
              <th className="py-1 text-start font-medium">{t`Inject`}</th>
              <th className="py-1 text-start font-medium">{t`Placed`}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const s = status(e);
              const placedOn = placements.filter((p) => p.placed.includes(e.name)).length;
              const total = placements.length;
              return (
                <tr key={e.name} className="border-b align-top" data-testid={`agent-env-row-${e.name}`}>
                  <td className="py-1.5 pe-2">
                    <div className="font-mono">{e.name}</div>
                    {e.description && <div className="text-muted-foreground">{e.description}</div>}
                    {editing === e.name && (
                      <div className="mt-1 flex items-center gap-1.5">
                        {e.kind === 'secret' ? (
                          <SecretValueInput
                            className="h-7 text-xs"
                            value={draft}
                            onValueChange={setDraft}
                            aria-label={t`Value of ${e.name}`}
                            data-testid={`agent-env-value-${e.name}`}
                          />
                        ) : (
                          <Input
                            className="h-7 text-xs"
                            value={draft}
                            onChange={(ev) => setDraft(ev.target.value)}
                            aria-label={t`Value of ${e.name}`}
                            data-testid={`agent-env-value-${e.name}`}
                          />
                        )}
                        <BusyButton
                          label={t`Save`}
                          testId={`agent-env-save-${e.name}`}
                          busy={busy === `set-${e.name}`}
                          disabled={busy !== null || (e.kind === 'secret' && !draft)}
                          onClick={() => void setValue(e)}
                        />
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pe-2" data-testid={`agent-env-kind-${e.name}`}>
                    {e.kind === 'secret' ? t`Secret` : t`Plain`}
                  </td>
                  <td className={`py-1.5 pe-2 ${s.className}`} data-testid={`agent-env-status-${e.name}`}>
                    {s.label}
                  </td>
                  <td className="py-1.5 pe-2">
                    <Switch
                      checked={e.inject}
                      disabled={busy !== null}
                      aria-label={t`Inject ${e.name} into deployments`}
                      onCheckedChange={(on) =>
                        void act(
                          `inject-${e.name}`,
                          () => replace(e.name, { inject: on }),
                          t`Could not change ${e.name}`,
                        )
                      }
                      data-testid={`agent-env-inject-${e.name}`}
                    />
                  </td>
                  <td className="py-1.5 pe-2 text-muted-foreground" data-testid={`agent-env-placed-${e.name}`}>
                    {t`placed on ${placedOn} of ${total}`}
                  </td>
                  <td className="py-1.5">
                    <div className="flex justify-end gap-1">
                      <BusyButton
                        label={t`Set`}
                        variant="outline"
                        testId={`agent-env-set-${e.name}`}
                        busy={false}
                        disabled={busy !== null}
                        onClick={() => {
                          setEditing(editing === e.name ? null : e.name);
                          setDraft(e.kind === 'plain' ? (e.value ?? '') : '');
                        }}
                      />
                      {e.kind === 'secret' && agent.remote && (
                        <BusyButton
                          label={t`Use mine`}
                          variant="outline"
                          testId={`agent-env-use-mine-${e.name}`}
                          busy={busy === `mine-${e.name}`}
                          disabled={busy !== null}
                          onClick={() => void copyMine(e)}
                        />
                      )}
                      <BusyButton
                        label={t`Forget`}
                        variant="outline"
                        testId={`agent-env-forget-${e.name}`}
                        busy={busy === `forget-${e.name}`}
                        disabled={busy !== null}
                        onClick={() => void forget(e)}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {adding ? (
        <section className="flex flex-col gap-2 rounded-md border p-2" data-testid="agent-env-add-form">
          {offered.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="font-medium text-muted-foreground">
                <Trans>From this agent's credentials</Trans>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {offered.map((d) => (
                  <Button
                    key={d.name}
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 font-mono text-xs"
                    title={d.credential}
                    disabled={busy !== null}
                    onClick={() => void add(d.name, d.secret ? 'secret' : 'plain')}
                    data-testid={`agent-env-add-pick-${d.name}`}
                  >
                    {d.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Input
              className="h-7 font-mono text-xs"
              value={newName}
              placeholder={t`VARIABLE_NAME`}
              aria-label={t`Variable name`}
              onChange={(ev) => setNewName(ev.target.value.trim())}
              data-testid="agent-env-add-name"
            />
            <Button
              size="sm"
              variant={newKind === 'secret' ? 'secondary' : 'ghost'}
              className="h-7 text-xs"
              onClick={() => setNewKind('secret')}
              data-testid="agent-env-add-kind-secret"
            >
              <Trans>Secret</Trans>
            </Button>
            <Button
              size="sm"
              variant={newKind === 'plain' ? 'secondary' : 'ghost'}
              className="h-7 text-xs"
              onClick={() => setNewKind('plain')}
              data-testid="agent-env-add-kind-plain"
            >
              <Trans>Plain</Trans>
            </Button>
            <BusyButton
              label={t`Add`}
              testId="agent-env-add-confirm"
              busy={busy === `add-${newName}`}
              disabled={busy !== null || !ENV_VAR_RE.test(newName) || entries.some((e) => e.name === newName)}
              onClick={() => void add(newName, newKind)}
            />
          </div>
        </section>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => setAdding(true)}
          data-testid="agent-env-add"
        >
          <Plus className="me-1.5 h-3.5 w-3.5" />
          <Trans>Add variable</Trans>
        </Button>
      )}

      <Collapsible data-testid="agent-env-system">
        <CollapsibleTrigger
          className="group flex items-center gap-1 font-medium text-muted-foreground"
          data-testid="agent-env-system-toggle"
        >
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
          <Trans>Provided by Flowpad</Trans>
          <span className="tabular-nums">({env.system.length})</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1 flex flex-col gap-1 ps-5">
          {env.system.length === 0 && (
            <p className="text-muted-foreground">
              <Trans>Shown once the agent is published.</Trans>
            </p>
          )}
          {env.system.map((row) => (
            <div key={row.name} className="flex items-center gap-2" data-testid={`agent-env-system-${row.name}`}>
              <span className="font-mono">{row.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.description}</span>
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
