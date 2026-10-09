import { t } from '@lingui/core/macro';
import { useMemo, useState } from 'react';
import { Cloud, HardDrive, UserPlus } from 'lucide-react';
import {
  dataManager,
  FlowMessage,
  fsManager,
  Project,
  QueryRequest,
  Task,
  TypeId,
  normalizeEmail,
  type ConversationParticipant,
  type TaskableMessage,
} from '@sdk';
import { STATUS_FAMILY_CHIP, statusLabel } from '@src/components/task-bar/constants';
import { isDelegatedTask, STATUS_FAMILIES, statusFamily, taskOwner, TaskStatus } from '@src/components/task-bar/task-utils';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { guardCloudAction } from '@src/services/privacy-guard';
import { useEntityBatch } from '@src/components/entity-batch/EntityBatchHydrator';
import { conversationMessagesRequest } from './conversation-messages-query';
import { CHIP_LAYOUT, chipStyleFor } from './EntityChip';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { DockPointer } from '@src/navigation/DockPointer';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { registerCommand } from '@src/notifications/commands';
import { notify } from '@src/notifications/notify';

/**
 * "Task it" — one click turns a conversation message into a task: a plain {@link Task} assigned to
 * me, pointing back at the message (`origin_conversation` / `origin_message`). The same call serves
 * the bubble's hover action and the composer's "send as task" toggle.
 */

const UNDO_COMMAND = 'task-it.undo';
const NO_TASKS: Task[] = [];
const NO_MESSAGES: FlowMessage[] = [];
/** Messages whose task is being created right now. The server answers a repeat create with the
 *  first task, but only once that task is saved; a double click lands inside the save. */
const inFlight = new Set<string>();

/** The control's tooltip, shared by the bubble and the composer. */
export const taskItHint = () => t`Task it — make this message a task`;

/** The Task type's own glyph (`TaskInfo.icon`), resolved only where the control renders. */
export function TaskItIcon({ className }: { className?: string }) {
  const Glyph = iconForType(Task.type);
  return <Glyph className={className} />;
}

/** The tasks linked to this conversation (`origin_conversation`): made from its messages ("Task it")
 *  or asked in it (the Vibe help button). One query, shared by every reader. */
function useLinkedTasks(conversationId: string | null | undefined): Task[] {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: Task.type,
        name: `messageTasks:${conversationId ?? 'none'}`,
        query: { origin_conversation: conversationId || '__none__' },
      }),
    [conversationId],
  );
  const { data: tasks = NO_TASKS } = useEntitiesQuery<Task>(request, { enabled: !!conversationId });
  return tasks;
}

/** The tasks made from this conversation's messages, keyed by message id. */
export function useMessageTasks(conversationId: string | null | undefined): Map<string, Task> {
  const tasks = useLinkedTasks(conversationId);
  return useMemo(() => {
    const byMessage = new Map<string, Task>();
    for (const task of tasks) if (task.origin_message) byMessage.set(task.origin_message, task);
    return byMessage;
  }, [tasks]);
}

/**
 * Every task of this conversation, once each: the ones linked to it (`origin_conversation` — the
 * sender's side), the conversation's own task (`ownTaskId` — what an assignee's copy is), and the
 * tasks its messages carry as chips. The last two are how a received task reaches the conversation:
 * its `origin_conversation` is the sender's local link and never travels.
 */
export function useConversationTasks(conversationId: string | null | undefined, ownTaskId?: string | null): Task[] {
  const linked = useLinkedTasks(conversationId);
  const messagesRequest = useMemo(() => conversationMessagesRequest(conversationId || '__none__'), [conversationId]);
  const { data: messages = NO_MESSAGES } = useEntitiesQuery<FlowMessage>(messagesRequest, {
    enabled: !!conversationId,
  });
  const attachedIds = useMemo(() => {
    const ids = new Set<string>();
    if (ownTaskId) ids.add(ownTaskId);
    for (const fm of messages) {
      for (const tid of fm.sharedContextEntities ?? []) if (tid.type === Task.type) ids.add(String(tid.id));
    }
    for (const task of linked) ids.delete(task.id);
    return [...ids];
  }, [messages, ownTaskId, linked]);
  const attached = useEntityBatch<Task>(Task.type, attachedIds);
  return useMemo(() => (attached.length ? [...linked, ...attached] : linked), [linked, attached]);
}

/** A task's status as a chip — its bucket's colors (New / In progress / Done). A button when it acts. */
export function TaskStatusChip({ status, onClick }: { status?: string; onClick?: () => void }) {
  const className = `${CHIP_LAYOUT} ${STATUS_FAMILY_CHIP[statusFamily(status)]}`;
  const label = statusLabel(status);
  return onClick ? (
    <button type="button" onClick={onClick} className={className} title={t`Status`} data-testid="task-status-chip">
      {label}
    </button>
  ) : (
    <span className={className} data-testid="task-status-chip">
      {label}
    </span>
  );
}

/** Who a task's owner is, as the chip says it: "Me" for my own, else the owner (the group, else the assignee). */
function ownerLabel(task: Task, me?: string | null): string | null {
  const owner = taskOwner(task);
  if (!owner) return null;
  return me && fold(owner) === fold(me) ? t`Me` : owner;
}

/** Where a task lives, said once: on this machine only, or shared through the cloud. */
function locationTip(task: Task, owner: string | null): string {
  return task.remote ? t`Shared via cloud with ${owner ?? ''}` : t`This task is local on this machine`;
}

/** The chip's face: where the task lives (local / cloud) and who owns it. */
function OwnerFace({ task, me }: { task: Task; me?: string | null }) {
  const label = ownerLabel(task, me);
  const Glyph = task.remote ? Cloud : HardDrive;
  return (
    <>
      <Glyph
        className={`h-3 w-3 shrink-0 ${task.remote ? 'text-cloud' : 'text-muted-foreground'}`}
        data-task-location={task.remote ? 'cloud' : 'local'}
        aria-hidden="true"
      />
      <span className="max-w-[14rem] truncate">{label}</span>
    </>
  );
}

/** A task's owner as a chip — where it lives (local / cloud) and who owns it; nothing when it has none. */
export function TaskOwnerChip({ task, me, onClick }: { task: Task; me?: string | null; onClick?: () => void }) {
  const owner = taskOwner(task);
  if (!owner) return null;
  const className = `${CHIP_LAYOUT} ${chipStyleFor()}`;
  const tip = locationTip(task, owner);
  return onClick ? (
    <button type="button" onClick={onClick} className={className} title={tip} data-testid="task-owner-chip">
      <OwnerFace task={task} me={me} />
    </button>
  ) : (
    <span className={className} title={tip} data-testid="task-owner-chip">
      <OwnerFace task={task} me={me} />
    </span>
  );
}

/** Who a task can be handed to from a conversation: its members, then the address book / an email. */
export interface TaskPeople {
  members?: ConversationParticipant[];
  /** My address — never offered to myself as "someone else", and how "Me" is recognized. */
  me?: string | null;
  /** My cloud user id — the roster names me by it. */
  cloudUserId?: string | null;
}

/** An address as compared everywhere (`normalizeEmail`), `''` for none. */
function fold(value: string | null | undefined): string {
  return normalizeEmail(value ?? '') ?? '';
}

function emailOf(p: ConversationParticipant): string {
  return fold(p.email);
}

/** Set a task's status — the one write every status surface makes. A shared task's save reflects to the
 *  hub (the store adds `Hub-Reflect` for a remote entity), so the other person has it too; the backend
 *  records the change as the task's history, which both threads read. */
export async function setTaskStatus(task: Task, status: string): Promise<void> {
  if (task.status === status) return;
  task.status = status;
  task.completed_at = status === TaskStatus.DONE ? new Date().toISOString() : undefined;
  try {
    await task.save();
    task.markEdit();
  } catch (e) {
    notify.error({ title: t`Could not save task`, message: e instanceof Error ? e.message : String(e) });
  }
}

/** A task's status as a menu: New / In progress / Done. Read-only for a delegated task (its ledger moves it). */
export function TaskStatusMenu({ task }: { task: Task }) {
  if (isDelegatedTask(task)) return <TaskStatusChip status={task.status} />;
  const current = statusFamily(task.status);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${CHIP_LAYOUT} ${STATUS_FAMILY_CHIP[current]}`}
          title={t`Change status`}
          data-testid="task-status-chip"
        >
          {statusLabel(task.status)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="task-status-menu">
        {STATUS_FAMILIES.map((status) => (
          <DropdownMenuItem
            key={status}
            disabled={status === current}
            onSelect={() => void setTaskStatus(task, status)}
            data-testid={`task-status-${status}`}
          >
            {statusLabel(status)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A task's owner as a menu: where it lives and who owns it, and — on click — hand it to someone: the
 *  conversation's members first, then the address book or an email. Handing it to someone else shares it
 *  through the cloud (`Task.assign`); in Local privacy mode only "Me" is offered. */
export function TaskOwnerMenu({ task, people }: { task: Task; people?: TaskPeople }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ConversationParticipant[]>([]);
  const [sending, setSending] = useState(false);
  const ensureCloudLogin = useCloudLoginGate();
  const me = fold(people?.me);
  const assignee = fold(task.assignee);
  const others = useMemo(() => {
    const seen = new Set<string>();
    return (people?.members ?? []).filter((p) => {
      const email = emailOf(p);
      const mine = (!!email && email === me) || (!!people?.cloudUserId && p.user_id === people.cloudUserId);
      if (mine || !email || email === assignee || seen.has(email)) return false;
      seen.add(email);
      return true;
    });
  }, [people?.members, people?.cloudUserId, me, assignee]);

  if (isDelegatedTask(task)) return <TaskOwnerChip task={task} me={people?.me} />;

  const assign = async (person: ConversationParticipant) => {
    const toMe = !!me && emailOf(person) === me;
    if (!toMe && !guardCloudAction('share')) return;
    setSending(true);
    try {
      // In a conversation the people are already here: no second conversation to tell them.
      await task.assign(person, { notify: false, ensureCloudLogin });
      task.markEdit();
      setOpen(false);
      setPicked([]);
    } catch (e) {
      notify.error({ title: t`Could not assign`, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  const owner = taskOwner(task);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPicked([]);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`${CHIP_LAYOUT} ${chipStyleFor()}`}
          title={locationTip(task, owner)}
          data-testid="task-owner-chip"
        >
          {owner ? <OwnerFace task={task} me={people?.me} /> : (
            <>
              <UserPlus className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{t`Assign`}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start" data-testid="task-owner-menu">
        <div className="flex flex-col gap-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t`Assign to`}</div>
          {me && assignee !== me && (
            <button
              type="button"
              disabled={sending}
              onClick={() => void assign({ email: me, name: null })}
              className="rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted"
              data-testid="task-owner-me"
            >
              {t`Me`}
            </button>
          )}
          {others.length > 0 && (
            <div className="flex flex-col" data-testid="task-owner-members">
              <div className="px-2 pb-0.5 text-[11px] text-muted-foreground">{t`In this conversation`}</div>
              {others.map((p) => (
                <button
                  key={emailOf(p)}
                  type="button"
                  disabled={sending}
                  onClick={() => void assign(p)}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted"
                  data-testid="task-owner-member"
                  data-email={emailOf(p)}
                >
                  <span className="truncate">{p.name || p.email}</span>
                  {p.name && <span className="truncate text-xs text-muted-foreground">{p.email}</span>}
                </button>
              ))}
            </div>
          )}
          <ContactPicker
            value={picked}
            onChange={setPicked}
            max={1}
            includeGroups={false}
            placeholder={t`Search a contact or type an email`}
            testId="task-owner-search"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {task.remote ? t`Shared via cloud` : t`Assigning someone else shares it through the cloud`}
            </span>
            <Button
              size="sm"
              disabled={!picked[0] || sending}
              onClick={() => picked[0] && void assign(picked[0])}
              data-testid="task-owner-assign"
            >
              {sending ? t`Assigning…` : t`Assign`}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The task under a message — its title (opens it), its status and its owner, both of which act. The same
 *  chips under a "Task it" message and on a task thread's first message. */
export function TaskChips({ task, onOpen, people }: { task: Task; onOpen: () => void; people?: TaskPeople }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="message-task-chips">
      <button
        type="button"
        onClick={onOpen}
        className={`${CHIP_LAYOUT} ${chipStyleFor(Task.type)}`}
        title={t`Open task`}
        aria-label={t`Open task`}
        data-testid="message-task-it"
      >
        <TaskItIcon className="h-3 w-3 shrink-0" />
        <span className="max-w-[24rem] truncate">{task.title || t`Task`}</span>
      </button>
      <TaskStatusMenu task={task} />
      <TaskOwnerMenu task={task} people={people} />
    </div>
  );
}

/** Create the task for a message, then offer Open / Undo. */
export async function taskIt(
  message: TaskableMessage,
  opts: { me?: string | null; projectId?: string | null },
): Promise<void> {
  const key = message.id ?? '';
  if (key && inFlight.has(key)) return;
  if (key) inFlight.add(key);
  try {
    const project = opts.projectId ? { typeId: new TypeId(Project.type, opts.projectId) } : null;
    const task = await Task.fromMessage(message, { me: opts.me, project });
    const typeId = task.typeId.toString();
    registerUndoCommand();
    notify.success({
      id: `task-it-${message.id ?? typeId}`,
      title: t`Tasked: ${task.title}`,
      typeId,
      actions: [
        { label: t`Open`, href: DockPointer.forAssetEditorByTypeId(Task.type, task.typeId).toUrl() },
        { label: t`Undo`, command: UNDO_COMMAND, args: { typeId } },
      ],
    });
  } catch (err) {
    console.error('[task-it] create failed', err);
    notify.error({ title: t`Could not create the task` });
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Undo = the task never happened: its row AND its folder. Deleting the row alone leaves `task.md`
 * on disk (the graph delete removes only the row — a workaround until it removes the carrier), and
 * the left folder would keep the name taken and come back on the next index scan.
 */
async function undoTaskIt(typeId: string): Promise<void> {
  const task = await dataManager.getByTypeId<Task>(new TypeId(typeId));
  if (!task) return;
  if (task.remote) {
    // Already handed to someone: it is on their machine too — taking it back is the owner's call, not an undo.
    notify.warning({ title: t`This task is already shared`, message: t`Reassign it to yourself instead.` });
    return;
  }
  const folder = task.asset_ref;
  await task.delete();
  if (folder) await fsManager.delete(LOCAL_COMPUTE_NODE, folder.replace(/^\/+/, ''));
}

/**
 * Registered when a toast first offers Undo, not on import: this module is imported by the message
 * bubble, which sits on an import cycle with the command registry, and a top-level registration ran
 * before the registry existed ("Cannot access 'registry' before initialization").
 */
function registerUndoCommand(): void {
  registerCommand(UNDO_COMMAND, (args, ctx) => {
    if (!args.typeId) return;
    notify.dismiss(ctx.id);
    void undoTaskIt(String(args.typeId)).catch((err) => {
      console.error('[task-it] undo failed', err);
      notify.error({ title: t`Could not remove the task` });
    });
  });
}
