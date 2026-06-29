/**
 * TasksViewer - Full dock view for creating/editing tasks.
 * Opened at dock/tasks/<task-id> or dock/tasks (new).
 * For shared tasks (spec_id set), renders SharedTaskView instead of the edit form.
 */

import { useState, useCallback, useMemo } from 'react';
import { Task, TypeId, isTypeId, dataManager, QueryRequest } from '@sdk';
import { useEntity, useProject } from '@sdk/react/hooks';
import { SharedTaskView } from '@src/components/task-bar/SharedTaskView';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Separator } from '@src/components/ui/separator';
import { Textarea } from '@src/components/ui/textarea';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Trans, useLingui } from '@lingui/react/macro';

export function TasksViewer() {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const { project } = useProject();
  const pointer = currentDock?.pointer;

  // Load existing task if pointer is a valid typeId. Pointers may carry a
  // sub-path `<taskId>/conversation/<convId>` — we parse the first segment as
  // the task id and the optional conversation tail as the canonical conv id
  // to hand down to SharedTaskView. The URL is the source of truth here
  // because `task.firstContextOfType('conversation')` can return null until
  // the task entity is fully hydrated (cache-miss races on first navigation
  // from another view leave the chip-loaded entity with empty context_entities).
  const taskTypeId = useMemo(() => {
    if (!pointer) return undefined;
    const head = pointer.split('/')[0];
    if (isTypeId(head)) return new TypeId(head);
    try {
      return new TypeId(Task.type, head);
    } catch {
      return undefined;
    }
  }, [pointer]);

  const urlConversationId = useMemo(() => {
    if (!pointer) return null;
    const parts = pointer.split('/').filter(Boolean);
    return parts.length >= 3 && parts[1] === 'conversation' ? parts[2] : null;
  }, [pointer]);

  const { data: existingTask, isLoading } = useEntity<Task>(taskTypeId ?? null, {
    enabled: !!taskTypeId,
  });

  const isEditing = !!existingTask;

  // Form state (must be declared before any early return — React hooks rule)
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('open');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [ttl, setTtl] = useState('');
  const [targetEntity, setTargetEntity] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Sync form with loaded task
  if (existingTask && !initialized) {
    setTitle(existingTask.title || '');
    setDescription(existingTask.descriptionPlainText || '');
    setStatus(existingTask.status || 'open');
    setPriority(existingTask.priority || 'medium');
    setDueDate(existingTask.due_at ? new Date(existingTask.due_at).toISOString().split('T')[0] : '');
    setStartDate(existingTask.start_date ? new Date(existingTask.start_date).toISOString().split('T')[0] : '');
    setTtl(existingTask.ttl != null ? String(existingTask.ttl / (1000 * 60 * 60)) : '');
    setTargetEntity(existingTask.target_entity || '');
    setInitialized(true);
  }

  const handleSave = useCallback(async () => {
    const scope = project?.typeId ? [project.typeId] : [];
    if (scope.length === 0) return;

    const task = existingTask || new Task({});
    task.title = title;
    task.descriptionPlainText = description;
    task.status = status;
    task.priority = priority;
    task.due_at = dueDate ? new Date(dueDate) : undefined;
    task.start_date = startDate || null;
    task.ttl = ttl ? parseFloat(ttl) * 1000 * 60 * 60 : null;
    task.target_entity = targetEntity || null;

    await task.save(scope);
    // Force-invalidate the task query cache so TaskBar gets fresh data on mount
    await dataManager.query(new QueryRequest({ type: Task.type, scope }), true);
    navigation.goBack();
  }, [
    existingTask,
    title,
    description,
    status,
    priority,
    dueDate,
    startDate,
    ttl,
    targetEntity,
    project?.typeId,
    navigation,
  ]);

  const handleDelete = useCallback(async () => {
    if (!existingTask || !project?.typeId) return;
    const scope = [project.typeId];
    existingTask.status = 'archived';
    existingTask.archived_at = new Date().toISOString();
    await existingTask.save(scope);
    await dataManager.query(new QueryRequest({ type: Task.type, scope }), true);
    navigation.goBack();
  }, [existingTask, project?.typeId, navigation]);

  // Wait for the task to load before deciding which layout to show — avoids
  // flashing the empty edit form before switching to SharedTaskView or the populated form.
  if (taskTypeId && (isLoading || !existingTask)) {
    return <div className="flex h-full items-center justify-center text-muted-foreground"><Trans>Loading…</Trans></div>;
  }

  // Shared tasks (sent via notification) show the SharedTaskView instead of the edit form.
  // Gate on shared_by_id (set by notification flow) rather than Spec presence — Scenarios B/C
  // create no-Spec tasks where the recipient drives the work via PROMPT replies.
  if (existingTask?.shared_by_id) {
    return (
      <SharedTaskView
        task={existingTask}
        conversationId={urlConversationId}
        onClose={() => navigation.goBack()}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <button
          onClick={() => navigation.goBack()}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-base font-semibold">{isEditing ? t`Edit Task` : t`New Task`}</h2>
      </div>

      {/* Form */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-1.5">
          <Label htmlFor="task-title"><Trans>Title</Trans></Label>
          <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t`Task title`} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="task-desc"><Trans>Description</Trans></Label>
          <Textarea
            id="task-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t`Describe the task...`}
            rows={4}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label><Trans>Status</Trans></Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open"><Trans>Open</Trans></SelectItem>
                <SelectItem value="in_progress"><Trans>In Progress</Trans></SelectItem>
                <SelectItem value="done"><Trans>Done</Trans></SelectItem>
                <SelectItem value="archived"><Trans>Archived</Trans></SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label><Trans>Priority</Trans></Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high"><Trans>High</Trans></SelectItem>
                <SelectItem value="medium"><Trans>Medium</Trans></SelectItem>
                <SelectItem value="low"><Trans>Low</Trans></SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="task-due"><Trans>Due date</Trans></Label>
            <Input id="task-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-start"><Trans>Start date</Trans></Label>
            <Input id="task-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="task-ttl"><Trans>TTL (hours)</Trans></Label>
            <Input
              id="task-ttl"
              type="number"
              min={0}
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              placeholder={t`Auto-archive after...`}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-target"><Trans>Target entity</Trans></Label>
            <Input
              id="task-target"
              value={targetEntity}
              onChange={(e) => setTargetEntity(e.target.value)}
              placeholder={t`TypeId string`}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <Separator />
      <div className="flex items-center justify-between px-4 py-3">
        {isEditing ? (
          <>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              <Trans>Archive</Trans>
            </Button>
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title={t`Archive task`}
              description={`Are you sure you want to archive "${title || 'Untitled'}"?`}
              confirmLabel={t`Archive`}
              variant="destructive"
              onConfirm={() => void handleDelete()}
            />
          </>
        ) : (
          <div />
        )}
        <Button size="sm" onClick={() => void handleSave()} disabled={!title.trim()}>
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {isEditing ? t`Save` : t`Create`}
        </Button>
      </div>
    </div>
  );
}
