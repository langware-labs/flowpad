import { ConversationParticipant, Task, TaskKind } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { guardCloudAction } from '@src/services/privacy-guard';
import { cn } from '@src/lib/utils';
import { User as UserIcon, Users } from 'lucide-react';
import { useState } from 'react';
import { GroupTaskDialog } from './GroupTaskDialog';

interface OwnerButtonProps {
  task: Task;
  save: (patch: Partial<Task>) => Promise<void>;
}

/**
 * The "Owner" pill in the task editor's meta row. Two paths:
 *  - Individual: a single-select ContactPicker writing the existing
 *    `assignee` field — nothing else.
 *  - Group: opens the GroupTaskDialog (explainer + contacts-group pick +
 *    `create-group-task`), turning this task into a group task.
 * Hidden for member tasks (`parent_id` set) — their assignee is fixed.
 */
export function OwnerButton({ task, save }: OwnerButtonProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'individual'>('menu');

  if (task.parent_id) return null;

  const isGroup = task.kind === TaskKind.GROUP;
  const label = isGroup ? 'Group' : task.assignee || 'Owner';
  const Icon = isGroup ? Users : UserIcon;

  const onPickIndividual = (next: ConversationParticipant[]) => {
    const picked = next[0];
    void save({ assignee: picked ? picked.email || picked.name || undefined : undefined });
    if (picked) {
      setPickerOpen(false);
      setMode('menu');
    }
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
                onClick={() => setMode('individual')}
                data-testid="task-owner-individual"
                className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
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
                className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
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
                value={task.assignee ? [{ email: task.assignee, name: null }] : []}
                onChange={onPickIndividual}
                max={1}
                includeGroups={false}
                placeholder="Search a contact or type an email"
              />
            </div>
          )}
        </PopoverContent>
      </Popover>

      <GroupTaskDialog task={task} open={groupDialogOpen} onOpenChange={setGroupDialogOpen} />
    </>
  );
}
