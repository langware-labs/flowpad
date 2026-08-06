import { Task } from '@sdk';
import { cn } from '@src/lib/utils';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface TaskDescriptionProps {
  task: Task;
  save: (patch: Partial<Task>) => Promise<void>;
  /** Display only — renders the text without the editing affordance. */
  readOnly?: boolean;
  /** Override the section header (defaults to "Description"). */
  heading?: ReactNode;
}

/**
 * The task's Description section — the free text of what the task is about,
 * stored in the entity's `description` (a Lexical document) and edited here
 * through the `descriptionPlainText` accessor, so what's typed round-trips into
 * `task.md`'s body.
 *
 * Commits on blur (and on ⌘/Ctrl+Enter), never on every keystroke: each save
 * re-renders `task.md` and hands back a new task ref, so per-character writes
 * would churn the whole editor.
 */
export function TaskDescription({ task, save, readOnly = false, heading }: TaskDescriptionProps) {
  const taskRef = useRef(task);
  taskRef.current = task;
  const taskKey = task.typeId.toString();

  const [text, setText] = useState(task.descriptionPlainText ?? '');
  // Re-seed when the surface swings to a different task, not on every save of
  // this one (a save yields a fresh ref with the same typeId).
  useEffect(() => setText(taskRef.current.descriptionPlainText ?? ''), [taskKey]);

  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  /** Grow the box to its content so long descriptions aren't read through a
   *  3-line slot; the section itself rides the page's scroll column. */
  const autoGrow = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(autoGrow, [text, autoGrow]);

  const commit = useCallback(() => {
    const next = text.trim();
    if (next === (taskRef.current.descriptionPlainText ?? '').trim()) return;
    void save({ descriptionPlainText: next });
  }, [text, save]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b px-6 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {heading ?? 'Description'}
        </span>
      </div>

      <div className="px-6 py-3">
        {readOnly ? (
          text.trim() ? (
            <p className="whitespace-pre-wrap text-sm text-foreground/80">{text}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No description</p>
          )
        ) : (
          <textarea
            ref={boxRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
            }}
            placeholder="Add a description…"
            rows={2}
            data-testid="task-description"
            className={cn(
              'w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm',
              'text-foreground placeholder:text-muted-foreground',
              'hover:border-input focus-visible:border-input focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
          />
        )}
      </div>
    </div>
  );
}
