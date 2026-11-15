import { useEffect, useState } from 'react';
import { LifeBuoy, Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { createHelpDesk } from '@sdk';
import { notify } from '@src/notifications';
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

interface NewHelpDeskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The desk was made (off): its id, for the caller to open its page. */
  onCreated: (deskId: string) => void;
}

/** New help desk — a name and who answers. It is made OFF; its page turns it on. */
export function NewHelpDeskDialog({ open, onOpenChange, onCreated }: NewHelpDeskDialogProps) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  const [staff, setStaff] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setStaff('');
  }, [open]);

  const create = async () => {
    const desk = name.trim();
    if (!desk || busy) return;
    setBusy(true);
    try {
      const emails = staff
        .split(/[\s,;]+/)
        .filter((email) => email.includes('@'));
      const deskId = await createHelpDesk(desk, emails);
      onOpenChange(false);
      onCreated(deskId);
    } catch (err) {
      notify.error({ title: t`Could not create the help desk`, message: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="new-help-desk-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LifeBuoy className="h-4 w-4 text-red-500" />
            <Trans>New help desk</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>People ask it like a contact. You and your team answer.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="new-help-desk-name">
            <Trans>Name</Trans>
          </Label>
          <Input
            id="new-help-desk-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t`Acme Support`}
            autoFocus
            data-testid="new-help-desk-name"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-help-desk-staff">
            <Trans>Staff members</Trans>
          </Label>
          <Input
            id="new-help-desk-staff"
            value={staff}
            onChange={(event) => setStaff(event.target.value)}
            placeholder={t`Emails, separated by commas — you are in already`}
            data-testid="new-help-desk-staff"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="button" onClick={() => void create()} disabled={!name.trim() || busy} data-testid="new-help-desk-create">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Trans>Create help desk</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
