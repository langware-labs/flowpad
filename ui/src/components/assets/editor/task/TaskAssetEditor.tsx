import { SharedTaskView } from '@src/components/task-bar/SharedTaskView';
import { missingDoneGateFields, PRIORITY_CONFIG, STATUS_LABELS } from '@src/components/task-bar/constants';
import { openArtifact } from '@src/components/task-bar/task-utils';
import { Input } from '@src/components/ui/input';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useParentTask } from '@src/hooks/use-parent-task';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ActionInfo, dataManager, FSRef, Task } from '@sdk';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { Archive, ArrowLeft, FileText, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnalyzeStatusButton } from './AnalyzeStatusButton';
import { DoneGateDialog } from './DoneGateDialog';
import { MemberTasksSection } from './MemberTasksSection';
import { OwnerButton } from './OwnerButton';
import { TaskAttachments } from './TaskAttachments';

interface TaskAssetEditorProps {
  /** FSRef to the task folder. task.md / spec.md are resolved via child(). */
  fsRef: FSRef;
  /** Pre-resolved task entity (passed by `<EntityResolutionGate>`). */
  task?: Task;
}

const STATUS_OPTIONS: { value: string; label: string }[] = ['to_do', 'in_progress', 'done'].map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

const PRIORITY_OPTIONS = ['high', 'medium', 'low'] as const;

/** Normalize legacy status values (`open`) onto the current enum. */
function normStatus(s?: string): string {
  if (s === 'open') return 'to_do';
  return s || 'to_do';
}

/** `Date | string | null` → `yyyy-mm-dd` for a native date input. */
function toDateInput(v?: Date | string | null): string {
  if (!v) return '';
  const d = typeof v === 'string' ? new Date(v) : v;
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * Task asset editor — the redesigned task surface. Task is a folder asset:
 * `task.md` holds the fields (owns_main_ref ⇒ the entity is the source of truth,
 * re-rendered on every save). The metadata is edited through a purpose-built
 * header bound to the entity, and the body is the Attachments section (the
 * files/folders this task is about, stored in `artifacts`). Received tasks
 * (`shared_by_id`) fall through to the collaboration `SharedTaskView`.
 *
 * Member tasks (`parent_id` set — one member's copy of a group task) render a
 * read-only view of the PARENT's display fields (single source of truth) with
 * only their own status editable.
 */
export function TaskAssetEditor({ fsRef, task: providedTask }: TaskAssetEditorProps) {
  const { entity: discoveredTask } = useEntityByPath<Task>(
    providedTask ? null : Task.type,
    providedTask ? null : fsRef,
  );
  const task = providedTask ?? discoveredTask;
  const { navigation } = useDockNavigation();

  // Keyed on the STABLE typeId so a metadata save() (which hands back a new
  // task ref) doesn't churn child state.
  const taskRef = useRef(task);
  taskRef.current = task;
  const taskKey = task ? task.typeId.toString() : null;
  const parentId = task?.parent_id || null;

  const parent = useParentTask(parentId);

  const [title, setTitle] = useState(task?.title ?? '');
  useEffect(() => setTitle(task?.title ?? ''), [taskKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [doneGateOpen, setDoneGateOpen] = useState(false);

  // Member task: opportunistically pull fresh parent display fields from the
  // hub (quiet no-op offline). Fire-and-forget — the watched parent query
  // repaints when the merge lands.
  useEffect(() => {
    if (!parentId || !taskRef.current?.id) return;
    void dataManager
      .callAction(new ActionInfo('sync-group', Task.type, taskRef.current.id, 'POST'))
      .catch(() => undefined);
  }, [parentId, taskKey]);

  const save = useCallback(async (patch: Partial<Task>) => {
    const t = taskRef.current;
    if (!t) return;
    Object.assign(t, patch);
    try {
      await t.save();
    } catch (e) {
      notify.error({
        title: 'Could not save task',
        message: e instanceof Error ? e.message : 'Save failed.',
      });
    }
  }, []);

  const commitTitle = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== taskRef.current?.title) void save({ title: trimmed });
  }, [title, save]);

  /** One code path for every status flip: stamps/clears completed_at, and
   *  gates Done behind the missing-fields dialog (suggest, never block). */
  const applyStatus = useCallback(
    (value: string) => {
      void save({
        status: value,
        completed_at: value === 'done' ? new Date().toISOString() : undefined,
      });
    },
    [save],
  );

  const handleStatusClick = useCallback(
    (value: string) => {
      const t = taskRef.current;
      if (value === 'done' && t && missingDoneGateFields(t as unknown as Record<string, unknown>).length > 0) {
        setDoneGateOpen(true); // gate — no save yet
        return;
      }
      applyStatus(value);
    },
    [applyStatus],
  );

  if (!task) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  // Received / shared tasks keep the collaboration surface (mapping + conversation).
  if (task.shared_by_id) {
    return <SharedTaskView task={task} conversationId={null} onClose={() => navigation.goBack()} />;
  }

  const status = normStatus(task.status);
  // Member mode: parent mirror resolved → its fields are the display source of
  // truth. Parent missing (deleted / not yet materialized) → plain editor on
  // the child's own fields, never a blank screen.
  const memberMode = !!parentId && !!parent;
  const displayTask = memberMode ? parent : task;
  const priority = displayTask.priority;
  const memberDescription = memberMode ? (parent.descriptionPlainText || '').trim() : '';

  return (
    <div className="flex h-full flex-col bg-background">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigation.goBack()}
            className="flex items-center gap-1 rounded p-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="uppercase tracking-wide">{memberMode ? 'Member task' : 'Task'}</span>
          </button>
          <button
            onClick={() => void save({ status: 'archived', archived_at: new Date().toISOString() })}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title="Archive task"
          >
            <Archive className="h-3.5 w-3.5" />
            Archive
          </button>
        </div>

        {memberMode ? (
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">{parent.title || 'Untitled task'}</h1>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              Member task of “{parent.title || 'Untitled task'}”
              {task.assignee ? <> · assigned to {task.assignee}</> : null}
            </div>
          </div>
        ) : (
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            placeholder="Untitled task"
            className="h-auto border-0 bg-transparent px-0 text-2xl font-semibold shadow-none focus-visible:ring-0"
          />
        )}

        {/* Meta pill row */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Status — segmented; always the task's OWN status (a member task
              owns nothing but this) */}
          <div className="inline-flex overflow-hidden rounded-full border">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleStatusClick(opt.value)}
                className={cn(
                  'px-3 py-1 text-xs font-medium transition-colors',
                  status === opt.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Priority — editable on own tasks, read-only from the parent on member tasks */}
          {memberMode ? (
            priority ? (
              <span className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs capitalize text-muted-foreground">
                <span className={cn('h-2 w-2 rounded-full', PRIORITY_CONFIG[priority]?.color)} />
                {priority}
              </span>
            ) : null
          ) : (
            <div className="inline-flex items-center gap-1">
              {PRIORITY_OPTIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => void save({ priority: priority === p ? undefined : p })}
                  title={PRIORITY_CONFIG[p]?.label}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs capitalize transition-colors',
                    priority === p
                      ? 'border-foreground/20 bg-muted text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  <span className={cn('h-2 w-2 rounded-full', PRIORITY_CONFIG[p]?.color)} />
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* Dates — read-only from the parent on member tasks */}
          {memberMode ? (
            <>
              {displayTask.due_at ? (
                <span className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                  <span className="text-[10px] uppercase tracking-wide">Due</span>
                  {toDateInput(displayTask.due_at)}
                </span>
              ) : null}
              {displayTask.start_date ? (
                <span className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                  <span className="text-[10px] uppercase tracking-wide">Start</span>
                  {toDateInput(displayTask.start_date)}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <label className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                <span className="text-[10px] uppercase tracking-wide">Due</span>
                <input
                  type="date"
                  value={toDateInput(task.due_at)}
                  onChange={(e) => void save({ due_at: e.target.value ? new Date(e.target.value) : undefined })}
                  className="bg-transparent text-xs text-foreground outline-none"
                />
              </label>
              <label className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                <span className="text-[10px] uppercase tracking-wide">Start</span>
                <input
                  type="date"
                  value={toDateInput(task.start_date)}
                  onChange={(e) => void save({ start_date: e.target.value || null })}
                  className="bg-transparent text-xs text-foreground outline-none"
                />
              </label>
            </>
          )}

          <OwnerButton task={task} save={save} />
          <AnalyzeStatusButton task={task} />
          {task.analysis_path && (
            <button
              type="button"
              onClick={() => openArtifact(task.analysis_path!, navigation)}
              className="flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60"
              title={task.analysis_path}
              data-testid="task-analysis-report"
            >
              <FileText className="h-3.5 w-3.5" />
              Report
            </button>
          )}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────── */}
      {memberMode ? (
        // The plan is not shared (task/spec decoupled) — show the parent's
        // synced description instead of an empty Plan editor.
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
          {memberDescription ? (
            <p className="whitespace-pre-wrap text-sm text-foreground">{memberDescription}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No description yet — the group task owner can add one.</p>
          )}
        </div>
      ) : (
        <>
          <MemberTasksSection task={task} />
          <TaskAttachments task={task} save={save} />
        </>
      )}

      <DoneGateDialog
        task={task}
        open={doneGateOpen}
        onOpenChange={setDoneGateOpen}
        onConfirmDone={() => applyStatus('done')}
      />
    </div>
  );
}
