import { useState } from 'react';
import { Lock } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { credentialsService } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { errorMessage } from '@src/lib/error-message';

/**
 * Secured transfer from the composer: type a Name and paste a Key — sealed for the other members' devices, saved
 * as a credential on their side with one click. "or pick a saved credential" opens today's picker.
 */
export function SecureSendDialog({
  conversationId,
  onClose,
  onPickSaved,
}: {
  conversationId: string;
  onClose: () => void;
  onPickSaved: () => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The field keeps only A-Z, 0-9 and _; the server checks the full rule.
  const valid = /^[A-Z_]/.test(name) && value.length > 0;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const sent = await credentialsService.sealedSend(conversationId, name, value);
      if (!sent.sealed_for.length) {
        setError(t`Nobody here can receive it yet — they need to open Flowpad once, then send again.`);
        return;
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e, t`The key could not be sent.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="secure-send-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            <Trans>Secured transfer</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="secure-send-name">
              <Trans>Name</Trans>
            </Label>
            <Input
              id="secure-send-name"
              className="font-mono"
              placeholder="OPENAI_API_KEY"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              data-testid="secure-send-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="secure-send-value">
              <Trans>Key</Trans>
            </Label>
            <Input
              id="secure-send-value"
              type="password"
              autoComplete="off"
              className="font-mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              data-testid="secure-send-value"
            />
          </div>
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title={t`End-to-end encrypted: only the other members' devices can open it, the hub sees the name, never the key.`}
          >
            <Lock className="h-3 w-3" />
            <Trans>Only the other members can open it — they save it as a credential.</Trans>
          </p>
          <button
            type="button"
            className="text-xs text-primary underline-offset-2 hover:underline"
            onClick={onPickSaved}
            data-testid="secure-send-pick-saved"
          >
            <Trans>or pick a saved credential</Trans>
          </button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!valid || busy} onClick={() => void send()} data-testid="secure-send-submit">
            <Trans>Send securely</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
