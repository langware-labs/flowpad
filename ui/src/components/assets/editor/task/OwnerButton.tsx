import { t } from '@lingui/core/macro';
import { ConversationParticipant, Task, TaskKind } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { guardCloudAction } from '@src/services/privacy-guard';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { User as UserIcon, Users } from 'lucide-react';
import { useState } from 'react';
import { GroupTaskDialog } from './GroupTaskDialog';

interface OwnerButtonProps {
  task: Task;
}

/**
 * The "Owner" pill in the task editor's meta row. Two paths:
 *  - Individual: a single-select ContactPicker + an optional message, committed
 *    through `Task.assign` — the ONE assign path, which shares the task and
 *    grants the assignee `editor` so it lands on their machine.
 *  - Group: opens the GroupTaskDialog (explainer + contacts-group pick +
 *    `create-group-task` + the same optional message to every member).
 * Hidden for member tasks (`parent_id` set) — their assignee is fixed.
 */
export function OwnerButton({ task }: OwnerButtonProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'individual'>('menu');
  const [picked, setPicked] = useState<ConversationParticipant[]>([]);
  const [message, setMessage] = useState('');
  const ensureCloudLogin = useCloudLoginGate();
  const [sending, setSending] = useState(false);

  if (task.parent_id) return null;

  const isGroup = task.kind === TaskKind.GROUP;
  // `group_name` is only ever set by the contacts-group fan-out; a task handed
  // to one person carries the person on `assignee`.
  const assigned = (isGroup && task.group_name) || task.assignee;
  const label = assigned ? `Owner: ${assigned}` : 'Owner';
  const Icon = isGroup ? Users : UserIcon;

  const openIndividual = () => {
    setPicked(task.assignee ? [{ email: task.assignee, name: null }] : []);
    setMessage('');
    setMode('individual');
  };

  const assignIndividual = async () => {
    const person = picked[0];
    if (!person) return;
    // ONE assign path: `Task.assign` shares the task and grants the assignee
    // `editor`, so it actually lands on their machine. This used to write
    // `assignee` locally and send a chip message — a notification about a task
    // the recipient never received, because nothing granted them a role.
    if (!guardCloudAction('share')) return;
    setSending(true);
    try {
      await task.assign(person, { message, ensureCloudLogin });
      notify.success({
        title: t`Task assigned`,
        message: t`${person.name || person.email} now has "${task.title}".`,
      });
    } catch (e: unknown) {
      notify.error({
        title: t`Could not assign`,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSending(false);
    }
    setPickerOpen(false);
    setMode('menu');
  };

  const openGroupFlow = () => {
    // Group tasks share to the hub — blocked in Local privacy mode, same gate
    // as every share surface (backend re-enforces with a 403).
    if (!guardCloudAction('share')) return;
    setPickerOpen(false);
    setMode('menu');
    setGroupDialogOpen(true);
  };

  return (
    <>
      <Popover
        open={pickerOpen}
        onOpenChange={(o) => {
          setPickerOpen(o);
          if (!o) setMode('menu');
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="task-owner-button"
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
              isGroup || task.assignee
                ? 'border-foreground/20 bg-muted text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted/60',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          {mode === 'menu' ? (
            <div className="flex flex-col gap-1">
              <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Assign this task to
              </div>
              <button
                type="button"
                onClick={openIndividual}
                data-testid="task-owner-individual"
                className="flex items-center gap-2 rounded-md px-2 py-2 text-start text-sm hover:bg-muted"
              >
                <UserIcon className="h-4 w-4 text-muted-foreground" />
                <span>
                  <span className="block font-medium">Individual</span>
                  <span className="block text-xs text-muted-foreground">One person owns this task</span>
                </span>
              </button>
              <button
                type="button"
                onClick={openGroupFlow}
                data-testid="task-owner-group"
                className="flex items-center gap-2 rounded-md px-2 py-2 text-start text-sm hover:bg-muted"
              >
                <Users className="h-4 w-4 text-muted-foreground" />
                <span>
                  <span className="block font-medium">Group</span>
                  <span className="block text-xs text-muted-foreground">
                    Every member of a contacts group gets their own copy
                  </span>
                </span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Pick the owner
              </div>
              <ContactPicker
                value={picked}
                onChange={setPicked}
                max={1}
                includeGroups={false}
                placeholder={t`Search a contact or type an email`}
              />
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t`Optional message to the owner…`}
                rows={2}
                data-testid="task-owner-message"
                className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => void assignIndividual()}
                  disabled={!picked[0] || sending}
                  data-testid="task-owner-assign"
                >
                  {sending ? 'Assigning…' : 'Assign'}
                </Button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <GroupTaskDialog task={task} open={groupDialogOpen} onOpenChange={setGroupDialogOpen} />
    </>
  );
}
