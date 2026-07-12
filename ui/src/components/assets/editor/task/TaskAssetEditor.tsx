import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { SharedTaskView } from '@src/components/task-bar/SharedTaskView';
import { PRIORITY_CONFIG } from '@src/components/task-bar/constants';
import { Input } from '@src/components/ui/input';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { FSRef, Task } from '@sdk';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { Archive, ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface TaskAssetEditorProps {
  /** FSRef to the task folder. task.md / spec.md are resolved via child(). */
  fsRef: FSRef;
  /** Pre-resolved task entity (passed by `<EntityResolutionGate>`). */
  task?: Task;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'to_do', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

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
 * re-rendered on every save) and the inner `spec.md` holds the plan. So the
 * metadata is edited through a purpose-built header bound to the entity, and the
 * plan rides the shared `MarkdownEditor` on `spec.md`. Received tasks
 * (`shared_by_id`) fall through to the collaboration `SharedTaskView`.
 */
export function TaskAssetEditor({ fsRef, task: providedTask }: TaskAssetEditorProps) {
  const { entity: discoveredTask } = useEntityByPath<Task>(
    providedTask ? null : Task.type,
    providedTask ? null : fsRef,
  );
  const task = providedTask ?? discoveredTask;
  const { navigation } = useDockNavigation();

  // Keyed on the STABLE typeId so a metadata save() (which hands back a new task
  // ref) doesn't remount the plan editor / churn the spec.md fsRef.
  const taskRef = useRef(task);
  taskRef.current = task;
  const taskKey = task ? task.typeId.toString() : null;

  const specRef = useMemo(
    () => taskRef.current?.specDoc ?? fsRef.child('spec.md'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskKey],
  );

  const [title, setTitle] = useState(task?.title ?? '');
  useEffect(() => setTitle(task?.title ?? ''), [taskKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(
    async (patch: Partial<Task>) => {
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
    },
    [],
  );

  const commitTitle = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== taskRef.current?.title) void save({ title: trimmed });
  }, [title, save]);

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  // Received / shared tasks keep the collaboration surface (mapping + conversation).
  if (task.shared_by_id) {
    return <SharedTaskView task={task} conversationId={null} onClose={() => navigation.goBack()} />;
  }

  const status = normStatus(task.status);
  const priority = task.priority;

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
            <span className="uppercase tracking-wide">Task</span>
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

        {/* Meta pill row */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Status — segmented */}
          <div className="inline-flex overflow-hidden rounded-full border">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => void save({ status: opt.value })}
                className={cn(
                  'px-3 py-1 text-xs font-medium transition-colors',
                  status === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Priority — color-dot pills */}
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

          {/* Dates */}
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
        </div>
      </div>

      {/* ── Plan (spec.md) ─────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b px-6 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Plan
        </div>
        <div className="min-h-0 flex-1">
          <MarkdownEditor fsRef={specRef} chatTarget={taskKey} />
        </div>
      </div>
    </div>
  );
}
