import { AppSecretSummary, Project, secretsService } from '@sdk';
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
import { useProjectSecretOrigins } from '@src/hooks/use-project-secret-origins';
import { notify } from '@src/notifications';
import { KeyRound, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface BindSecretDialogProps {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function envNameFromSecret(name: string): string {
  const candidate = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^(\d)/, '_$1')
    .toUpperCase();
  return candidate || 'SECRET';
}

/**
 * BindSecretDialog — bind an existing app secret to a project env var. Owns the
 * whole flow: secrets-store enablement, app-secret listing, and the bind form,
 * so any opener (the ProjectHome Secrets card, the quick-create "Secret" tile)
 * is just a trigger. Refreshes enablement + the secret list on every open.
 */
export const BindSecretDialog: React.FC<BindSecretDialogProps> = ({ project, open, onOpenChange }) => {
  const { t } = useLingui();
  const { addLocalPointer } = useProjectSecretOrigins(project);

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [appSecrets, setAppSecrets] = useState<AppSecretSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [envVar, setEnvVar] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelected('');
    setEnvVar('');
    void (async () => {
      try {
        const status = await secretsService.isEnabled();
        const isEnabled = Boolean(status?.enabled);
        setEnabled(isEnabled);
        setAppSecrets(isEnabled ? await secretsService.list() : []);
      } catch {
        setEnabled(false);
        setAppSecrets([]);
      }
    })();
  }, [open]);

  const handleEnable = async () => {
    setBusy(true);
    try {
      const status = await secretsService.enable();
      const isEnabled = Boolean(status?.enabled);
      setEnabled(isEnabled);
      if (isEnabled) setAppSecrets(await secretsService.list());
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
      onOpenChange(false);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Bind secret</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Bind an existing app secret to a project environment variable.</Trans>
          </DialogDescription>
        </DialogHeader>

        {enabled === null ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : !enabled ? (
          <div className="grid gap-3 py-2">
            <div className="flex items-center gap-2 rounded border border-dashed px-3 py-3 text-xs text-muted-foreground">
              <KeyRound className="h-4 w-4 shrink-0" />
              <span>
                <Trans>The local secrets store is not enabled yet.</Trans>
              </span>
            </div>
            <Button type="button" onClick={() => void handleEnable()} disabled={busy} data-testid="bind-secret-enable">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              <Trans>Enable secrets</Trans>
            </Button>
          </div>
        ) : appSecrets.length === 0 ? (
          <div className="flex items-center gap-2 rounded border border-dashed px-3 py-3 text-xs text-muted-foreground">
            <KeyRound className="h-4 w-4 shrink-0" />
            <span>
              <Trans>No local app secrets</Trans>
            </span>
          </div>
        ) : (
          <>
            <div className="grid gap-3 py-2">
              <div className="grid gap-1.5">
                <Label htmlFor="project-secret-name">
                  <Trans>Secret</Trans>
                </Label>
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
                <Label htmlFor="project-secret-env">
                  <Trans>Env var</Trans>
                </Label>
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
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="button" onClick={() => void handleAdd()} disabled={!selected || !envVar.trim() || busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                <Trans>Bind</Trans>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
