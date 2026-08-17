import { t } from '@lingui/core/macro';
import { ActionInfo, ContactsGroup, dataManager, normalizeEmail, Task, TypeId } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { groupActionRef } from '@src/components/contact-picker/computed-groups';
import { useContactsGroups } from '@src/components/contact-picker/use-contacts-groups';
import { WikiLabel } from '@src/components/wiki-tip';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useTaskAssignmentMessage } from '@src/hooks/use-task-assignment-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { Users } from 'lucide-react';
import { useState } from 'react';

interface GroupTaskDialogProps {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CreateGroupTaskResult {
  created?: string[];
  skipped?: string[];
  failed?: { email: string | null; error: string }[];
  /** Member-task typeids (no PII in the payload) — the recipient match runs
   *  locally against each task row's `assignee`. */
  children?: string[];
}

/**
 * The "assign to a group" confirmation flow: explains what a task group is
 * (with a WikiLabel into the "Group Tasks" wiki page), lets the user pick a
 * contacts group, and fires the backend `create-group-task` action. No
 * navigation side effects — the created member tasks land in the task list
 * through the watched query.
 */
export function GroupTaskDialog({ task, open, onOpenChange }: GroupTaskDialogProps) {
  const { groups } = useContactsGroups(open);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const { sendAssignment } = useTaskAssignmentMessage(task);
  const ensureCloudLogin = useCloudLoginGate();

  const selected = groups.find((g) => g.id === selectedId) ?? null;

  const create = async () => {
    if (!selected || !task.id || busy) return;
    setLocalError(null);
    // `create-group-task` creates the member tasks ON THE HUB — without cloud
    // login it 403s. Open the login flow first and resume on the same click,
    // exactly like the share dialog's send.
    const gate = await ensureCloudLogin();
    if (!gate.ok) {
      setLocalError(gate.error);
      return;
    }
    setBusy(true);
    try {
      // callAction reads the POST body from the ActionInfo itself — a second
      // argument would be silently ignored.
      const actionInfo = new ActionInfo('create-group-task', Task.type, task.id, 'POST');
      actionInfo.bodyParameters = groupActionRef(selected);
      const result = await dataManager.callAction<Record<string, unknown>, CreateGroupTaskResult>(actionInfo);
      const created = result?.created?.length ?? 0;
      const failed = result?.failed ?? [];
      if (failed.length) {
        notify.warning({
          title: t`Group task created with issues`,
          message: `${created} member task(s) created; ${failed.length} failed (${failed
            .map((f) => f.email ?? f.error)
            .join(', ')}). Re-run to retry.`,
        });
      } else {
        notify.success({
          title: t`Group task created`,
          message: t`${created} member task(s) created for "${selected.displayName ?? selected.name}".`,
        });
      }
      // The assignment message (push-notify channel): ONE conversation PER
      // member, each carrying that member's OWN member-task chip (not the
      // group overview) + the git-folder chips. Members never share a thread
      // — consistent with the member-isolation model. The response carries
      // only typeids (no PII); the recipient match reads each local task
      // row's `assignee`.
      const childByAssignee = new Map<string, string>();
      for (const tid of result?.children ?? []) {
        const child = await dataManager.getByTypeId<Task>(new TypeId(tid));
        const assignee = normalizeEmail(child?.assignee);
        if (assignee) childByAssignee.set(assignee, tid);
      }
      let messageFailures = 0;
      for (const recipient of (selected.contacts ?? []).filter((c) => !!c.email)) {
        const childTypeid = childByAssignee.get(normalizeEmail(recipient.email) ?? '');
        if (!childTypeid) continue; // member failed above — already reported
        const convId = await sendAssignment([recipient], message, childTypeid);
        if (!convId) messageFailures += 1;
      }
      if (messageFailures > 0) {
        notify.warning({
          title: t`Members assigned, but some messages failed`,
          message: t`The member tasks were created; ${messageFailures} notification message(s) did not go through.`,
        });
      }
      onOpenChange(false);
    } catch (e) {
      notify.error({
        title: t`Could not create group task`,
        message: e instanceof Error ? e.message : 'The group task could not be created.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a task group</DialogTitle>
          <DialogDescription>
            This creates a <span className="font-medium text-foreground">task group</span>: the same task, instantiated
            once for every member of a contacts group. Each member gets their own member task to work and track; this
            task becomes the group overview and single source of truth. Learn more:{' '}
            <WikiLabel wikiword="Group Tasks" label="W" />
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-56 flex-col gap-1 overflow-y-auto py-1" data-testid="group-task-group-list">
          {groups.length === 0 && (
            <div className="px-1 py-4 text-center text-sm text-muted-foreground">
              No contacts groups yet — create one from the Inbox first.
            </div>
          )}
          {groups.map((g: ContactsGroup) => (
            <button
              key={g.id}
              type="button"
              onClick={() => setSelectedId(g.id ?? null)}
              className={cn(
                'flex items-center justify-between rounded-md border px-3 py-2 text-start text-sm transition-colors',
                selectedId === g.id ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted',
              )}
            >
              <span className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                {g.displayName ?? g.name}
                {g.computed && <span className="text-[10px] uppercase text-muted-foreground/70">auto</span>}
              </span>
              <span className="text-xs text-muted-foreground">
                {(g.contacts ?? []).length} member{(g.contacts ?? []).length === 1 ? '' : 's'}
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t`Optional message to the members…`}
            rows={2}
            data-testid="group-task-message"
            className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        )}

        {localError && (
          <p className="text-xs text-destructive" data-testid="group-task-error">
            {localError}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!selected || busy} data-testid="group-task-confirm">
            {busy ? 'Creating…' : selected ? `Assign to ${(selected.contacts ?? []).length} members` : 'Assign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
