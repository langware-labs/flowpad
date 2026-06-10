import { useState } from 'react';
import { ShieldCheck, Trash2 } from 'lucide-react';
import { PermissionAction } from '@sdk';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import {
  grantContactPermission,
  revokeContactPermission,
  useContactPermissions,
  type ContactKey,
} from '@src/hooks/use-contact-permissions';

interface ContactPermissionsDialogProps {
  open: boolean;
  onClose: () => void;
  contact: ContactKey & { name?: string | null };
}

const ACTION_LABEL: Record<string, string> = {
  [PermissionAction.EXECUTE_PROMPT]: 'Auto-run prompts',
  [PermissionAction.AUTO_REPLY]: 'Auto-reply',
};

/**
 * Manage a contact's prompt permissions (the receiver's local policy): toggle
 * the two global capabilities, and review / remove any project-scoped rows that
 * were granted in-context from the Execute dialog. Opened from the address book.
 */
export function ContactPermissionsDialog({ open, onClose, contact }: ContactPermissionsDialogProps) {
  const { permissions, refetch } = useContactPermissions(open ? contact : null);
  const [busy, setBusy] = useState(false);
  const who = contact.name?.trim() || contact.email?.trim() || 'this contact';

  const globalRow = permissions.find((p) => (p.project_id ?? null) === null);
  const projectRows = permissions.filter((p) => (p.project_id ?? null) !== null);

  const hasGlobal = (action: PermissionAction) => !!globalRow?.allowed_actions?.includes(action);

  const toggleGlobal = async (action: PermissionAction, on: boolean) => {
    setBusy(true);
    try {
      if (on) await grantContactPermission(contact, null, action);
      else await revokeContactPermission(contact, null, action);
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const removeProjectRow = async (projectId: string, action: PermissionAction) => {
    setBusy(true);
    try {
      await revokeContactPermission(contact, projectId, action);
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="contact-permissions-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Permissions · {who}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[11px] uppercase tracking-widest text-muted-foreground">
              All projects
            </legend>
            {([PermissionAction.EXECUTE_PROMPT, PermissionAction.AUTO_REPLY] as const).map((action) => (
              <label key={action} className="flex items-center gap-2">
                <Checkbox
                  checked={hasGlobal(action)}
                  onCheckedChange={(v) => void toggleGlobal(action, !!v)}
                  disabled={busy}
                  data-testid={`contact-perm-global-${action}`}
                />
                <span>{ACTION_LABEL[action]} from {who}</span>
              </label>
            ))}
          </fieldset>

          {projectRows.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Per-project
              </legend>
              {projectRows.map((row) => (
                <div key={row.id} className="rounded-md border border-border px-2 py-1.5">
                  <div className="truncate font-mono text-[10px] text-muted-foreground" title={row.project_id ?? ''}>
                    {row.project_id}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {(row.allowed_actions ?? []).map((action) => (
                      <span
                        key={action}
                        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                      >
                        {ACTION_LABEL[action] ?? action}
                        <button
                          type="button"
                          className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                          disabled={busy}
                          onClick={() => void removeProjectRow(row.project_id!, action as PermissionAction)}
                          aria-label={`Remove ${action}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </fieldset>
          )}

          {permissions.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No permissions yet. Grant them here, or from the Execute dialog when a
              prompt arrives.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose} disabled={busy}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
