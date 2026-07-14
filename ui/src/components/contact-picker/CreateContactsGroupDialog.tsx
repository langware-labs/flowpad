import { useEffect, useState } from 'react';
import { Loader2, UsersRound } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ContactsGroup, type ConversationParticipant } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
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
import { AddressBookButton } from './AddressBookButton';
import { ContactPicker } from './ContactPicker';

interface CreateContactsGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * CreateContactsGroupDialog — name a contacts group and pick its members with
 * the same autocomplete used when adding people to a conversation. The saved
 * group then shows up in every ContactPicker dropdown, where selecting it
 * bulk-adds the members to the conversation.
 */
export function CreateContactsGroupDialog({ open, onOpenChange }: CreateContactsGroupDialogProps) {
  const { t } = useLingui();
  const ctx = useDataContext();
  const { cloudUser } = useAuth();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<ConversationParticipant[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setMembers([]);
  }, [open]);

  const canCreate = name.trim().length > 0 && members.length > 0 && !busy;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const group = new ContactsGroup({ name: name.trim(), contacts: members });
      await group.save();
      notify.success({ title: t`Contacts group "${name.trim()}" created` });
      onOpenChange(false);
    } catch (err) {
      notify.error({
        title: t`Failed to create contacts group`,
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="create-contacts-group-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersRound className="h-5 w-5 text-primary" />
            <Trans>New contacts group</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Pick a group in any conversation to add all its members at once.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="contacts-group-name">
              <Trans>Group name</Trans>
            </Label>
            <Input
              id="contacts-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t`e.g. My class`}
              disabled={busy}
              autoFocus
              data-testid="contacts-group-name-input"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>
              <Trans>Members</Trans>
            </Label>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <ContactPicker
                  value={members}
                  onChange={setMembers}
                  excludeUserId={cloudUser?.id ?? ctx.user?.id}
                  enabled={open}
                  disabled={busy}
                  includeGroups={false}
                  testId="contacts-group-member-input"
                />
              </div>
              <AddressBookButton
                value={members}
                onChange={setMembers}
                excludeUserId={cloudUser?.id ?? ctx.user?.id}
                enabled={open}
                disabled={busy}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
            data-testid="contacts-group-create"
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
