/**
 * Constants and helpers for the TaskBar component.
 */

export const BULK_SELECT_MIN_TASKS = 1;

export type TaskTab = 'active' | 'pending' | 'archived';

export const TASK_TABS: { id: TaskTab; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'pending', label: 'Pending' },
  { id: 'archived', label: 'Archived' },
];

export const PRIORITY_CONFIG: Record<string, { color: string; label: string }> = {
  high: { color: 'bg-red-500', label: 'High' },
  medium: { color: 'bg-amber-500', label: 'Medium' },
  low: { color: 'bg-green-500', label: 'Low' },
};

/** Display labels for the stored task status values (values never change —
 *  every task.md frontmatter carries them). `to_do` reads as "New". */
export const STATUS_LABELS: Record<string, string> = {
  to_do: 'New',
  in_progress: 'In progress',
  done: 'Done',
};

export function statusLabel(s?: string): string {
  return STATUS_LABELS[s ?? ''] ?? (s || 'New');
}

export function getPriorityColor(priority?: string): string {
  return PRIORITY_CONFIG[priority || 'low']?.color || 'bg-muted-foreground';
}

export function isTaskActive(task: {
  status?: string;
  start_date?: string | null;
  archived_at?: string | null;
}): boolean {
  if (task.status === 'archived' || task.archived_at) return false;
  if (task.start_date && new Date(task.start_date) > new Date()) return false;
  return true;
}

export function isTaskPending(task: {
  status?: string;
  start_date?: string | null;
  archived_at?: string | null;
}): boolean {
  if (task.status === 'archived' || task.archived_at) return false;
  return !!task.start_date && new Date(task.start_date) > new Date();
}

export function isTaskArchived(task: { status?: string; archived_at?: string | null }): boolean {
  return task.status === 'archived' || !!task.archived_at;
}

export function formatDueDate(dueAt?: Date | string | null): string {
  if (!dueAt) return '';
  const date = typeof dueAt === 'string' ? new Date(dueAt) : dueAt;
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
