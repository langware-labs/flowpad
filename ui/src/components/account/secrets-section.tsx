import { useEffect, useState } from 'react';
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
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to load secrets',
      });
    }
  };

  const handleEnable = async () => {
    setBusy(true);
    try {
      const result = await secretsService.enable();
      if (result?.enabled) {
        setEnabled(true);
        notify.success({ title: 'Secrets enabled' });
      } else {
        notify.error({
          title: 'Could not enable secrets',
          message: 'Keychain approval was not granted',
        });
      }
    } catch (error) {
      notify.error({
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to enable secrets',
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
      notify.success({ title: 'Secret saved', message: trimmed });
    } catch (error) {
      notify.error({
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to save secret',
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
      notify.success({ title: 'Secret deleted', message: secretName });
    } catch (error) {
      notify.error({
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to delete secret',
      });
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }

  if (!enabled) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          App secrets are stored in your operating system keychain. Enable to allow Flowpad to securely store
          third-party API keys and other secrets used by your flows.
        </p>
        <Button onClick={() => void handleEnable()} disabled={busy}>
          {busy ? 'Requesting…' : 'Enable secrets'}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {secrets.length} secret{secrets.length === 1 ? '' : 's'}
        </p>
        <Button size="sm" onClick={() => setShowAdd(true)} disabled={busy}>
          <Plus className="mr-1 h-4 w-4" />
          Add secret
        </Button>
      </div>

      {secrets.length === 0 ? (
        <p className="text-xs text-muted-foreground">No secrets yet. Click "Add secret" to create one.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {secrets.map((s) => (
            <li key={s.name} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">{s.name}</p>
                {s.description && (
                  <p className="truncate text-xs text-muted-foreground">{s.description}</p>
                )}
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setConfirmDelete(s.name)}
                disabled={busy}
                aria-label={`Delete ${s.name}`}
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
            <DialogTitle>Add secret</DialogTitle>
            <DialogDescription>
              The value is stored in your operating system keychain and never readable from this UI.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                placeholder="OPENAI_API_KEY"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="secret-value">Value</Label>
              <Input
                id="secret-value"
                type="password"
                placeholder="sk-…"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="secret-description">Description (optional)</Label>
              <Textarea
                id="secret-description"
                placeholder="What is this secret used for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setShowAdd(false); resetForm(); }} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={busy || !name.trim() || !value}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => { if (!next) setConfirmDelete(null); }}
        title="Delete secret"
        description={`Delete "${confirmDelete ?? ''}" from the OS keychain? This cannot be undone.`}
        confirmLabel="Delete"
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
