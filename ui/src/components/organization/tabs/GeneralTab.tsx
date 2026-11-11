/** General: the organization's name, its id, sharing, and deleting it behind a typed confirmation. */
import { TypeId, dataManager, type OrgBudgets } from '@sdk';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { EditableTitle } from '@src/components/organization/budgets/EditableTitle';
import { ShareOrgButton } from '@src/components/organization/budgets/OrgSharePanel';
import { renameEntity } from '@src/components/organization/budgets/rename-entity';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { TabTitle } from './shared';

export function GeneralTab({
  data,
  onChanged,
  onDeleted,
}: {
  data: OrgBudgets;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t } = useLingui();
  const { org } = data;
  const orgTypeId = useMemo(() => new TypeId('organization', org.id), [org.id]);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    try {
      await dataManager.getByTypeId(orgTypeId);
      await dataManager.delete(orgTypeId);
      setConfirming(false);
      onDeleted();
    } catch (e) {
      notify.error({ title: t`Could not delete ${org.name}`, message: errorMessage(e, ''), id: 'org-delete' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div data-testid="org-general-tab">
      <TabTitle title={<Trans>General</Trans>} />
      <section className="mb-5 rounded-lg border border-border px-4 py-4">
        <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-x-4 gap-y-4 text-sm">
          <span className="text-muted-foreground">
            <Trans>Name</Trans>
          </span>
          <EditableTitle
            name={org.name}
            onRename={async (next) => {
              await renameEntity(orgTypeId, next);
              onChanged();
            }}
            manage={org.can_manage}
            copyId={org.id}
            headingClassName="text-sm font-medium"
            testIdPrefix="org"
          />
          {org.can_invite && (
            <>
              <span className="text-muted-foreground">
                <Trans>Sharing</Trans>
              </span>
              <span>
                <ShareOrgButton orgId={org.id} orgName={org.name} />
              </span>
            </>
          )}
        </div>
      </section>

      {org.can_manage && (
        <section className="rounded-lg border border-destructive/50 px-4 py-4" data-testid="org-danger-zone">
          <div className="mb-1 text-sm font-semibold text-destructive">
            <Trans>Danger zone</Trans>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              <Trans>Deletes every team and budget in this organization. You'll type its name to confirm.</Trans>
            </span>
            <Button
              size="sm"
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10"
              onClick={() => {
                setTyped('');
                setConfirming(true);
              }}
              data-testid="org-delete"
            >
              <Trans>Delete organization…</Trans>
            </Button>
          </div>
        </section>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent data-testid="org-delete-dialog">
          <DialogHeader>
            <DialogTitle>
              <Trans>Delete {org.name}?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Every team and budget inside {org.name} is deleted with it. This cannot be undone. Type the
                organization's name to confirm.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={org.name}
            data-testid="org-delete-confirm-name"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="destructive"
              disabled={typed.trim() !== org.name || deleting}
              onClick={() => void remove()}
              data-testid="org-delete-confirm"
            >
              <Trans>Delete organization</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
