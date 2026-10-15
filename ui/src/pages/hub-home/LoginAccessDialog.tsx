import type { ComputeNode } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { type LoginAccess, loginAccessOf, setLoginAccess } from '@src/hooks/use-sandboxes';
import { LoginAccessField } from '@src/pages/hub-home/LoginAccessField';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface LoginAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandbox: ComputeNode | null;
  /** Called after the hub accepted the change, so the card list can refetch. */
  onSaved: () => void;
}

/**
 * Change who may sign an existing box in from a browser.
 *
 * The launch dialogs set it once; this is the card's way back to it. Owner-only
 * on the hub — anyone else gets the hub's refusal shown here, not a silent no-op.
 */
export function LoginAccessDialog({ open, onOpenChange, sandbox, onSaved }: LoginAccessDialogProps) {
  const { t } = useLingui();
  const [value, setValue] = useState<LoginAccess | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !sandbox) return;
    setValue(loginAccessOf(sandbox));
    setSaving(false);
    setError('');
  }, [open, sandbox]);

  const save = async () => {
    if (!sandbox || !value) return;
    setSaving(true);
    setError('');
    try {
      await setLoginAccess(sandbox, value);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="login-access-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Login access for {sandbox?.name || t`sandbox`}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Logging in opens the full FlowPad on this sandbox. Only the owner can change who may.</Trans>
          </DialogDescription>
        </DialogHeader>

        {value && <LoginAccessField value={value} onChange={setValue} testId="card-allow-login" />}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter className="mt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void save()} disabled={saving || !value} data-testid="login-access-save">
            {saving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
