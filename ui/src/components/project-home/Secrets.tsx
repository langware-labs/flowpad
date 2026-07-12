import { AppSecretSummary, Project, TypeId, secretsService } from '@sdk';
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
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { useEntity } from '@src/hooks/entity-hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useProjectSecretOrigins } from '@src/hooks/use-project-secret-origins';
import { notify } from '@src/notifications';
import { KeyRound, Loader2, Plus, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface SecretsProps {
  spawnProjectId?: string | null;
}

function envNameFromSecret(name: string): string {
  const candidate = name.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^(\d)/, '_$1').toUpperCase();
  return candidate || 'SECRET';
}

export const Secrets: React.FC<SecretsProps> = ({ spawnProjectId }) => {
  const { t } = useLingui();
  const dataCtx = useDataContext();
  const spawnTypeId = useMemo(
    () => (spawnProjectId ? new TypeId(Project.type, spawnProjectId) : null),
    [spawnProjectId],
  );
  const { data: pinnedProject } = useEntity<Project>(spawnTypeId, { watch: true, enabled: !!spawnTypeId });
  const project = (pinnedProject ?? dataCtx.project) as Project | null;
  const { secretOrigins, addLocalPointer, remove } = useProjectSecretOrigins(project);

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [appSecrets, setAppSecrets] = useState<AppSecretSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [envVar, setEnvVar] = useState('');

  const refresh = async () => {
    try {
      const status = await secretsService.isEnabled();
      const isEnabled = Boolean(status?.enabled);
      setEnabled(isEnabled);
      setAppSecrets(isEnabled ? await secretsService.list() : []);
    } catch {
      setEnabled(false);
      setAppSecrets([]);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!project) return null;

  const handleEnable = async () => {
    setBusy(true);
    try {
      const status = await secretsService.enable();
      setEnabled(Boolean(status?.enabled));
      if (status?.enabled) {
        setAppSecrets(await secretsService.list());
      }
    } catch (error) {
      notify.error({
        title: t`Error`,
        message: error instanceof Error ? error.message : t`Failed to enable secrets`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async () => {
    if (!selected || !envVar.trim()) return;
    setBusy(true);
    try {
      await addLocalPointer(selected, envVar.trim(), selected);
      setOpen(false);
      setSelected('');
      setEnvVar('');
    } catch (error) {
      notify.error({
        title: t`Error`,
        message: error instanceof Error ? error.message : t`Failed to bind secret`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full max-w-md flex-col gap-2" data-testid="project-secrets">
      <div className="flex items-center justify-between gap-2">
        <span className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Trans>Secrets</Trans>
        </span>
        {enabled ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setOpen(true)}
            disabled={busy || appSecrets.length === 0}
            title={t`Bind secret`}
            data-testid="project-secret-add"
          >
            <Plus className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void handleEnable()}
            disabled={busy || enabled === null}
            title={t`Enable secrets`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {secretOrigins.length > 0 && (
        <div className="flex flex-col gap-1">
          {secretOrigins.map((origin) => (
            <div
              key={origin.typeid}
              className="flex items-center gap-2 rounded border bg-muted/30 px-2.5 py-1.5"
              data-testid={`project-secret-row-${origin.typeid}`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs text-foreground" title={origin.env_var}>
                  {origin.env_var}
                </div>
                <div className="truncate text-[11px] text-muted-foreground" title={origin.name}>
                  {origin.name}
                </div>
              </div>
              <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                {origin.scope === 'shared' ? <Trans>Shared</Trans> : <Trans>Private</Trans>}
              </span>
              <button
                type="button"
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void remove(origin.typeid)}
                title={t`Remove secret binding`}
                data-testid={`project-secret-remove-${origin.typeid}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {enabled && appSecrets.length === 0 && (
        <div className="flex items-center gap-2 rounded border border-dashed px-3 py-3 text-xs text-muted-foreground">
          <KeyRound className="h-4 w-4 shrink-0" />
          <span><Trans>No local app secrets</Trans></span>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle><Trans>Bind secret</Trans></DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Bind an existing app secret to a project environment variable.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="project-secret-name"><Trans>Secret</Trans></Label>
              <Select
                value={selected}
                onValueChange={(value) => {
                  setSelected(value);
                  if (!envVar) setEnvVar(envNameFromSecret(value));
                }}
              >
                <SelectTrigger id="project-secret-name">
                  <SelectValue placeholder={t`Select secret`} />
                </SelectTrigger>
                <SelectContent>
                  {appSecrets.map((secret) => (
                    <SelectItem key={secret.name} value={secret.name}>
                      {secret.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="project-secret-env"><Trans>Env var</Trans></Label>
              <Input
                id="project-secret-env"
                value={envVar}
                onChange={(e) => setEnvVar(e.target.value)}
                className="font-mono"
                autoCapitalize="characters"
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="button" onClick={() => void handleAdd()} disabled={!selected || !envVar.trim() || busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              <Trans>Bind</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
