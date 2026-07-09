/**
 * TaskBar - Main container for the task sidebar.
 *
 * Replaces CostDashboard in the HomeLanding right column.
 * Features: pill tabs, search, scrollable task list, sliding detail panel.
 * Supports bulk selection mode for acting on multiple tasks at once.
 */

import { Archive, CheckSquare, Plus, RotateCcw, Search, Sparkles, Trash2, X, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SkillItem, Trigger } from '@sdk';
import { Task } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { useProjectTasks } from '@src/hooks/use-project-tasks';
import { useTaskMutations } from '@src/hooks/use-task-mutations';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Trans, useLingui } from '@lingui/react/macro';

import { TaskStatusTabs } from './TaskStatusTabs';
import { TaskCard } from './TaskCard';
import { TaskDetailPanel } from './TaskDetailPanel';
import { SharedTaskView } from './SharedTaskView';
import { BulkReminderButton } from './BulkReminderButton';
import { BULK_SELECT_MIN_TASKS, isTaskActive, isTaskArchived, isTaskPending, type TaskTab } from './constants';
import './TaskBar.css';

export function TaskBar() {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();

  const [selectedTab, setSelectedTab] = useState<TaskTab>('active');
  const [search, setSearch] = useState('');
  const [expandedTask, setExpandedTask] = useState<Task | null>(null);

  // Bulk select state
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Bulk confirmation dialogs
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false);
  const [confirmBulkReminder, setConfirmBulkReminder] = useState<Date | null>(null);

  const isOnArchivedTab = selectedTab === 'archived';

  // Shared task data + mutations (sniffer watching is handled inside useProjectTasks)
  const { data: tasks, refetch, excludeTasks, projectTypeId } = useProjectTasks();
  const { removeTasks, setTaskReminder, bulkReminder } = useTaskMutations({
    refetch,
    excludeTasks,
  });

  // ── Auto-expand task from dock pointer (e.g. navigated via bookmark click) ──
  useEffect(() => {
    const pointer = currentDock?.pointer;
    if (!pointer || !tasks?.length) return;
    // pointer is a task ID like "620ffea5-..." or a typeId like "task-620ffea5-..."
    const rawId = pointer.startsWith('task-') ? pointer.slice(5) : pointer;
    const found = tasks.find((t) => t.id === rawId || t.id === pointer);
    if (found && expandedTask?.id !== found.id) {
      setExpandedTask(found);
    }
  }, [currentDock?.pointer, tasks]);

  // ── TTL-based auto-archiving ──
  const autoArchivedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!tasks || !projectTypeId) return;
    const now = Date.now();
    for (const task of tasks) {
      if (
        task.id &&
        !autoArchivedRef.current.has(task.id) &&
        task.ttl != null &&
        task.status !== 'archived' &&
        !task.archived_at &&
        task.created_date
      ) {
        const createdAt = new Date(task.created_date).getTime();
        if (createdAt + task.ttl < now) {
          autoArchivedRef.current.add(task.id);
          task.status = 'archived';
          task.archived_at = new Date().toISOString();
          void task.save([projectTypeId]);
        }
      }
    }
  }, [tasks, projectTypeId]);

  // Filter by tab
  const tabFiltered = useMemo(() => {
    switch (selectedTab) {
      case 'active':
        return tasks.filter(isTaskActive);
      case 'pending':
        return tasks.filter(isTaskPending);
      case 'archived':
        return tasks.filter(isTaskArchived);
    }
  }, [tasks, selectedTab]);

  // Filter by search
  const filteredTasks = useMemo(() => {
    if (!search.trim()) return tabFiltered;
    const q = search.toLowerCase();
    return tabFiltered.filter(
      (t) =>
        t.title?.toLowerCase().includes(q) ||
        t.descriptionPlainText?.toLowerCase().includes(q) ||
        t.tags?.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [tabFiltered, search]);

  const handleCreate = async () => {
    try {
      const task = await new Task({ title: 'Untitled task' }).save();
      navigation.openDock(DockPointer.forAssetEditorByTypeId('task', task.typeId));
    } catch (e) {
      notify.error({
        title: 'Could not create task',
        message: e instanceof Error ? e.message : 'Create failed.',
      });
    }
  };

  // Single-task remove (archive or delete depending on current status)
  const handleRemove = useCallback(
    async (task: Task) => {
      if (expandedTask?.id === task.id) {
        setExpandedTask(null);
      }
      await removeTasks([task]);
    },
    [expandedTask, removeTasks],
  );

  const handleSetReminder = useCallback(
    async (task: Task, date: Date) => {
      await setTaskReminder(task, date);
    },
    [setTaskReminder],
  );

  const handleExpand = (task: Task) => {
    setExpandedTask(task);
  };

  const handleCollapse = () => {
    setExpandedTask(null);
  };

  // ── Bulk mode handlers ──

  const exitBulkMode = useCallback(() => {
    setBulkMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleBulkMode = useCallback(() => {
    if (bulkMode) {
      exitBulkMode();
    } else {
      setBulkMode(true);
      setSelectedIds(new Set());
      setExpandedTask(null);
    }
  }, [bulkMode, exitBulkMode]);

  const handleToggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const getSelectedTasks = useCallback(
    () => filteredTasks.filter((t) => t.id && selectedIds.has(t.id)),
    [filteredTasks, selectedIds],
  );

  const executeBulkRemove = useCallback(async () => {
    const selected = getSelectedTasks();
    if (selected.length === 0) return;
    exitBulkMode();
    await removeTasks(selected);
  }, [getSelectedTasks, exitBulkMode, removeTasks]);

  const executeBulkReminder = useCallback(
    async (date: Date) => {
      const selected = getSelectedTasks();
      if (selected.length === 0) return;
      exitBulkMode();
      await bulkReminder(selected, date);
    },
    [getSelectedTasks, exitBulkMode, bulkReminder],
  );

  // Gate on shared_by_id, not Spec presence — Scenarios B/C are no-Spec shared tasks.
  const isSharedTask = !!expandedTask?.shared_by_id;
  const isSlid = expandedTask != null && !isSharedTask;
  const showBulkSelectButton = filteredTasks.length >= BULK_SELECT_MIN_TASKS;
  const removeLabel = isOnArchivedTab ? 'Delete' : 'Archive';
  const RemoveIcon = isOnArchivedTab ? Trash2 : Archive;

  return (
    <div className="task-bar-container flex h-full flex-col rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold"><Trans>Tasks</Trans></h3>
          {tabFiltered.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {tabFiltered.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleCreate}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t`New task`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Bulk toolbar OR tab section */}
      {bulkMode ? (
        <div className="task-bar-bulk-toolbar">
          <span className="text-xs font-medium text-muted-foreground">{selectedIds.size} selected</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              className="task-card-action task-card-action-archive"
              title={`${removeLabel} selected`}
              disabled={selectedIds.size === 0}
              onClick={() => setConfirmBulkRemove(true)}
            >
              <RemoveIcon className="h-3.5 w-3.5" />
            </button>
            <BulkReminderButton onSetReminder={(date) => setConfirmBulkReminder(date)} />
            <button className="task-card-action" title={t`Exit bulk select`} onClick={exitBulkMode}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <div className="border-b border-border p-3">
          <TaskStatusTabs selected={selectedTab} onSelect={setSelectedTab} />
        </div>
      )}

      {/* Search */}
      <div className="task-bar-search">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          className="task-bar-search-input"
          placeholder={t`Search tasks...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {showBulkSelectButton && (
          <button
            className={`task-bar-bulk-toggle ${bulkMode ? 'active' : ''}`}
            title={bulkMode ? t`Exit select mode` : t`Select multiple`}
            onClick={toggleBulkMode}
          >
            <CheckSquare className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Full-screen shared task view (for notification tasks with spec) */}
      {isSharedTask && expandedTask ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <SharedTaskView task={expandedTask} onClose={handleCollapse} />
        </div>
      ) : (
        /* Slider track (regular tasks) */
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="task-bar-slider-track" style={{ transform: isSlid ? 'translateX(-50%)' : 'translateX(0)' }}>
            {/* Panel 1: Task list */}
            <div className="task-bar-panel">
              <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
                {filteredTasks.length === 0 ? (
                  <div className="task-bar-empty">
                    <span>No {selectedTab} tasks</span>
                  </div>
                ) : (
                  filteredTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onExpand={handleExpand}
                      onRemove={(t) => void handleRemove(t)}
                      onSetReminder={(t, d) => void handleSetReminder(t, d)}
                      bulkMode={bulkMode}
                      isSelected={!!(task.id && selectedIds.has(task.id))}
                      onToggleSelect={handleToggleSelect}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Panel 2: Task detail */}
            <div className="task-bar-panel">
              {expandedTask && <TaskDetailPanel task={expandedTask} onClose={handleCollapse} />}
            </div>
          </div>
        </div>
      )}

      {/* Bulk remove confirmation */}
      <ConfirmDialog
        open={confirmBulkRemove}
        onOpenChange={setConfirmBulkRemove}
        title={`${removeLabel} ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}`}
        description={`Are you sure you want to ${removeLabel.toLowerCase()} ${selectedIds.size} selected task${selectedIds.size === 1 ? '' : 's'}?`}
        confirmLabel={removeLabel}
        variant="destructive"
        onConfirm={() => void executeBulkRemove()}
      />

      {/* Bulk reminder confirmation */}
      <ConfirmDialog
        open={confirmBulkReminder != null}
        onOpenChange={(open) => {
          if (!open) setConfirmBulkReminder(null);
        }}
        title={`Set reminder for ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}`}
        description={`Are you sure you want to set a reminder for ${selectedIds.size} selected task${selectedIds.size === 1 ? '' : 's'}?`}
        confirmLabel={t`Set reminder`}
        onConfirm={() => {
          if (confirmBulkReminder) void executeBulkReminder(confirmBulkReminder);
        }}
      />
    </div>
  );
}

// ─── Automations (Skills + Triggers + Hooks Sidebar) ─────────────────────────

// ── Unified automation item ──

type AutomationItem =
  | { kind: 'skill'; data: SkillItem; name: string; scope?: string; usageCount: number; sortKey: number }
  | { kind: 'trigger'; data: Trigger; name: string; scope?: string; usageCount: number; sortKey: number };

const AUTOMATION_ICONS = {
  skill: Sparkles,
  trigger: Zap,
} as const;

const AUTOMATION_COLORS = {
  skill: 'text-purple-500',
  trigger: 'text-amber-500',
} as const;

export interface AutomationsProps {
  /** Skills from project scan */
  skills?: SkillItem[];
  /** Trigger entities */
  triggers?: Trigger[];
  /** Skill name -> latest absolute usage count from live sniffer events */
  skillUsageCounts?: Map<string, number>;
  /** Called when a skill is deleted (folder removed) */
  onDeleteSkill?: (skill: SkillItem) => void;
  /** Called when a trigger is deleted */
  onDeleteTrigger?: (trigger: Trigger) => void;
  /** Called when the user clicks "Clear counters" */
  onClearCounters?: () => void;
}

/** @deprecated Use AutomationsProps */
export type ActivationsProps = AutomationsProps;

function AutomationCard({ item, onDelete }: { item: AutomationItem; onDelete?: () => void }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const Icon = AUTOMATION_ICONS[item.kind];
  const colorClass = AUTOMATION_COLORS[item.kind];

  const handleClick = () => {
    // Navigate to the Assets tab for both skills and triggers
    navigation.openDock(DockPointer.forTab(ViewType.ASSETS));
  };

  return (
    <div className="automation-card-wrapper">
      <button className="automation-card" onClick={handleClick} title={item.name}>
        <Icon className={`h-4 w-4 shrink-0 ${colorClass}`} />
        <div className="ml-1 min-w-0 flex-1">
          <div className="min-w-0 truncate text-sm font-medium">{item.name}</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {item.scope ? `${item.scope} ` : ''}
            {item.kind}
          </div>
        </div>
        {item.usageCount > 0 && (
          <span
            className="automation-usage-count"
            title={`Used ${item.usageCount} time${item.usageCount === 1 ? '' : 's'}`}
          >
            {item.usageCount}
          </span>
        )}
      </button>
      {onDelete && (
        <div className="automation-card-actions">
          <button
            className="automation-card-archive"
            title={t`Delete`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export function Automations({
  skills = [],
  triggers = [],
  skillUsageCounts,
  onDeleteSkill,
  onDeleteTrigger,
  onClearCounters,
}: AutomationsProps) {
  const { t } = useLingui();
  const [search, setSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<AutomationItem | null>(null);

  const items = useMemo<AutomationItem[]>(() => {
    const result: AutomationItem[] = [];

    for (const skill of skills) {
      result.push({
        kind: 'skill',
        data: skill,
        name: skill.name,
        scope: skill.scope ?? undefined,
        usageCount: skillUsageCounts?.get(skill.name) ?? skill.usage_count ?? 0,
        sortKey: skill.modified_at ? new Date(skill.modified_at).getTime() : 0,
      });
    }

    for (const trigger of triggers) {
      if (!trigger.enabled) continue;
      result.push({
        kind: 'trigger',
        data: trigger,
        name: trigger.name,
        scope: undefined,
        usageCount: trigger.counter ?? 0,
        sortKey: trigger.last_triggered ? new Date(trigger.last_triggered).getTime() : 0,
      });
    }

    // Sort by usage count (most used first), then by last usage/modified time
    result.sort((a, b) => b.usageCount - a.usageCount || b.sortKey - a.sortKey);
    return result;
  }, [skills, triggers, skillUsageCounts]);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q) ||
        (item.scope ?? '').toLowerCase().includes(q),
    );
  }, [items, search]);

  const handleDelete = (item: AutomationItem) => {
    if (item.kind === 'skill') {
      onDeleteSkill?.(item.data);
    } else if (item.kind === 'trigger') {
      onDeleteTrigger?.(item.data);
    }
    setPendingDelete(null);
  };

  return (
    <div className="task-bar-container flex h-full flex-col rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold"><Trans>Automations</Trans></h3>
          {filtered.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {filtered.length}
            </span>
          )}
        </div>
        {onClearCounters && (
          <button
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t`Clear all counters`}
            onClick={onClearCounters}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="task-bar-search">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          className="task-bar-search-input"
          placeholder={t`Search automations...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Unified list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <div className="task-bar-empty">
            <span>{search.trim() ? <Trans>No matching automations</Trans> : <Trans>No automations yet</Trans>}</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((item) => (
              <AutomationCard
                key={`${item.kind}-${item.kind === 'trigger' ? item.data.id : item.data.id || item.name}`}
                item={item}
                onDelete={() => setPendingDelete(item)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.kind}?`}
        description={`This will permanently delete "${pendingDelete?.name}". This cannot be undone.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => pendingDelete && handleDelete(pendingDelete)}
      />
    </div>
  );
}

/** @deprecated Use Automations */
export const Activations = Automations;
