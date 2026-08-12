import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AppSecretSummary, secretsService } from '@sdk';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
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
import { Textarea } from '@src/components/ui/textarea';
import { notify } from '@src/notifications';
import { Plus, Trash2 } from 'lucide-react';

export function SecretsSection() {
  const { t } = useLingui();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [secrets, setSecrets] = useState<AppSecretSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    void refreshEnabled();
  }, []);

  useEffect(() => {
    if (enabled) void refreshList();
  }, [enabled]);

  const refreshEnabled = async () => {
    try {
      const result = await secretsService.isEnabled();
      setEnabled(Boolean(result?.enabled));
    } catch {
      setEnabled(false);
    }
  };

  const refreshList = async () => {
    try {
      const list = await secretsService.list();
      setSecrets(list ?? []);
    } catch (error) {
      notify.error({
        title: t`Error`,
        message: error instanceof Error ? error.message : t`Failed to load secrets`,
      });
    }
  };

  const handleEnable = async () => {
    setBusy(true);
    try {
      const result = await secretsService.enable();
      if (result?.enabled) {
        setEnabled(true);
        notify.success({ title: t`Secrets enabled` });
      } else {
        notify.error({
          title: t`Could not enable secrets`,
          message: t`Keychain approval was not granted`,
        });
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

  const resetForm = () => {
    setName('');
    setValue('');
    setDescription('');
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || !value) return;
    setBusy(true);
    try {
      await secretsService.write(trimmed, value, description.trim() || undefined);
      setShowAdd(false);
      resetForm();
      await refreshList();
      notify.success({ title: t`Secret saved`, message: trimmed });
    } catch (error) {
      notify.error({
        title: t`Error`,
        message: error instanceof Error ? error.message : t`Failed to save secret`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (secretName: string) => {
    setBusy(true);
    try {
      await secretsService.delete(secretName);
      await refreshList();
      notify.success({ title: t`Secret deleted`, message: secretName });
    } catch (error) {
      notify.error({
        title: t`Error`,
        message: error instanceof Error ? error.message : t`Failed to delete secret`,
      });
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }

  if (!enabled) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          <Trans>
            App secrets are stored in your operating system keychain. Enable to allow Flowpad to securely store
            third-party API keys and other secrets used by your flows.
          </Trans>
        </p>
        <Button onClick={() => void handleEnable()} disabled={busy}>
          {busy ? t`Requesting…` : t`Enable secrets`}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          <Trans>
            {secrets.length} secret{secrets.length === 1 ? '' : 's'}
          </Trans>
        </p>
        <Button size="sm" onClick={() => setShowAdd(true)} disabled={busy}>
          <Plus className="me-1 h-4 w-4" />
          <Trans>Add secret</Trans>
        </Button>
      </div>

      {secrets.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <Trans>No secrets yet. Click "Add secret" to create one.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {secrets.map((s) => (
            <li key={s.name} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">{s.name}</p>
                {s.description && <p className="truncate text-xs text-muted-foreground">{s.description}</p>}
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setConfirmDelete(s.name)}
                disabled={busy}
                aria-label={t`Delete ${s.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={showAdd}
        onOpenChange={(next) => {
          setShowAdd(next);
          if (!next) resetForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Add secret</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>The value is stored in your operating system keychain and never readable from this UI.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="secret-name">
                <Trans>Name</Trans>
              </Label>
              <Input
                id="secret-name"
                placeholder={t`OPENAI_API_KEY`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="secret-value">
                <Trans>Value</Trans>
              </Label>
              <Input
                id="secret-value"
                type="password"
                placeholder={t`sk-…`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="secret-description">
                <Trans>Description (optional)</Trans>
              </Label>
              <Textarea
                id="secret-description"
                placeholder={t`What is this secret used for?`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setShowAdd(false);
                resetForm();
              }}
              disabled={busy}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={() => void handleSave()} disabled={busy || !name.trim() || !value}>
              {busy ? t`Saving…` : t`Save`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmDelete(null);
        }}
        title={t`Delete secret`}
        description={t`Delete "${confirmDelete ?? ''}" from the OS keychain? This cannot be undone.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (target) void handleDelete(target);
        }}
      />
    </div>
  );
}
