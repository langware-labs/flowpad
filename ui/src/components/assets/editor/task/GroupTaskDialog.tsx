import { ActionInfo, ContactsGroup, dataManager, Task } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useContactsGroups } from '@src/components/contact-picker/use-contacts-groups';
import { WikiLabel } from '@src/components/wiki-tip';
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
  const [busy, setBusy] = useState(false);

  const selected = groups.find((g) => g.id === selectedId) ?? null;

  const create = async () => {
    if (!selected || !task.id || busy) return;
    setBusy(true);
    try {
      const result = await dataManager.callAction<{ group_id: string }, CreateGroupTaskResult>(
        new ActionInfo('create-group-task', Task.type, task.id, 'POST'),
        { group_id: selected.id },
      );
      const created = result?.created?.length ?? 0;
      const failed = result?.failed ?? [];
      if (failed.length) {
        notify.warning({
          title: `Group task created with issues`,
          message: `${created} member task(s) created; ${failed.length} failed (${failed
            .map((f) => f.email ?? f.error)
            .join(', ')}). Re-run to retry.`,
        });
      } else {
        notify.success({
          title: 'Group task created',
          message: `${created} member task(s) created for "${selected.displayName ?? selected.name}".`,
        });
      }
      onOpenChange(false);
    } catch (e) {
      notify.error({
        title: 'Could not create group task',
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
                'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                selectedId === g.id ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted',
              )}
            >
              <span className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                {g.displayName ?? g.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {(g.contacts ?? []).length} member{(g.contacts ?? []).length === 1 ? '' : 's'}
              </span>
            </button>
          ))}
        </div>

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
