import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataContext, fsManager } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AlertTriangle, CheckCircle2, Circle, Clock, FileText, Loader2, ArrowRight } from 'lucide-react';

interface TaskData {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  blocks?: string[];
  blockedBy?: string[];
}

interface Props {
  sessionId: string;
  selectedActiveForm?: string;
  projectEncodedName?: string;
}

const STATUS_CONFIG = {
  in_progress: {
    icon: Clock,
    label: 'In Progress',
    badgeClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    borderClass: 'border-blue-300 dark:border-blue-700',
  },
  pending: {
    icon: Circle,
    label: 'Pending',
    badgeClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    borderClass: 'border-gray-200 dark:border-gray-700',
  },
  completed: {
    icon: CheckCircle2,
    label: 'Completed',
    badgeClass: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    borderClass: 'border-green-300 dark:border-green-700',
  },
} as const;

const STATUS_ORDER: TaskData['status'][] = ['in_progress', 'pending', 'completed'];

function TaskIdLink({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      className="text-primary hover:underline"
    >
      #{id}
    </button>
  );
}

function TaskCard({
  task,
  isSelected,
  cardRef,
  onSelectTask,
}: {
  task: TaskData;
  isSelected?: boolean;
  cardRef?: (el: HTMLDivElement | null) => void;
  onSelectTask: (id: string) => void;
}) {
  const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const StatusIcon = config.icon;

  return (
    <div
      ref={cardRef}
      className={`rounded-lg border p-3 ${config.borderClass} ${isSelected ? 'ring-2 ring-primary' : ''}`}
    >
      <div className="flex items-start gap-2">
        <StatusIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">#{task.id}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${config.badgeClass}`}>
              {config.label}
            </span>
          </div>
          <p className="mt-0.5 text-sm">{task.subject}</p>
          {task.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description}</p>}
          {task.activeForm && task.status === 'in_progress' && (
            <p className="mt-1 text-xs italic text-blue-600 dark:text-blue-400">{task.activeForm}</p>
          )}
          {task.blockedBy?.length || task.blocks?.length ? (
            <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
              {task.blockedBy?.length ? (
                <span className="flex items-center gap-1">
                  <ArrowRight className="h-3 w-3 rotate-180" />
                  Blocked by:{' '}
                  {task.blockedBy.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <TaskIdLink id={id} onSelect={onSelectTask} />
                    </span>
                  ))}
                </span>
              ) : null}
              {task.blocks?.length ? (
                <span className="flex items-center gap-1">
                  <ArrowRight className="h-3 w-3" />
                  Blocks:{' '}
                  {task.blocks.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <TaskIdLink id={id} onSelect={onSelectTask} />
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ClaudeTasksViewer({ sessionId, selectedActiveForm, projectEncodedName }: Props) {
  const { navigation } = useDockNavigation();
  const [tasks, setTasks] = useState<TaskData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const taskCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const home = dataContext.bootstrapInfo?.desktop_info?.paths?.home;
    const computeNode = dataContext.computeNode;
    if (!home || !computeNode?.typeId) {
      setError('Could not resolve compute node or home directory');
      setLoading(false);
      return;
    }

    let cancelled = false;
    const typeId = computeNode.typeId;
    const tasksDir = `${home}/.claude/tasks/${sessionId}`;

    const loadTasks = async () => {
      try {
        setLoading(true);
        setError(null);

        const browseResult = await fsManager.listDirectory(typeId, tasksDir);
        const jsonFiles = (browseResult?.items || []).filter((item: { name: string }) => item.name.endsWith('.json'));

        const loadedTasks: TaskData[] = [];
        for (const file of jsonFiles) {
          try {
            const filePath = `${tasksDir}/${file.name}`;
            const content = await fsManager.download(typeId, filePath);
            const text = typeof content === 'string' ? content : await content.text();
            const data = JSON.parse(text);
            loadedTasks.push({
              id: data.id || file.name.replace('.json', ''),
              subject: data.subject || 'Untitled task',
              description: data.description,
              activeForm: data.activeForm,
              status: data.status || 'pending',
              blocks: data.blocks,
              blockedBy: data.blockedBy,
            });
          } catch {
            // Skip individual files that fail to parse
          }
        }

        if (!cancelled) {
          setTasks(loadedTasks);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load tasks');
          setLoading(false);
        }
      }
    };

    void loadTasks();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const grouped = useMemo(() => {
    const groups: Record<string, TaskData[]> = {};
    for (const status of STATUS_ORDER) {
      groups[status] = tasks.filter((t) => t.status === status);
    }
    return groups;
  }, [tasks]);

  const completedCount = grouped.completed?.length || 0;
  const totalCount = tasks.length;

  // Resolve which task to highlight (initial selection from props)
  const initialSelectedId = useMemo(() => {
    if (tasks.length === 0) return null;
    if (selectedActiveForm) {
      const match = tasks.find((t) => t.activeForm === selectedActiveForm);
      if (match) return match.id;
    }
    return tasks[0]?.id ?? null;
  }, [tasks, selectedActiveForm]);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Sync initial selection
  useEffect(() => {
    if (initialSelectedId) setSelectedTaskId(initialSelectedId);
  }, [initialSelectedId]);

  // Scroll selected task into view
  useEffect(() => {
    if (!selectedTaskId) return;
    const timer = setTimeout(() => {
      const el = taskCardRefs.current.get(selectedTaskId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedTaskId]);

  const handleSelectTask = useCallback((id: string) => {
    setSelectedTaskId(id);
  }, []);

  const setTaskCardRef = useCallback(
    (taskId: string) => (el: HTMLDivElement | null) => {
      if (el) {
        taskCardRefs.current.set(taskId, el);
      } else {
        taskCardRefs.current.delete(taskId);
      }
    },
    [],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        <span>Loading tasks...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
        <AlertTriangle className="mr-2 h-5 w-5 text-amber-500" />
        <span>{error}</span>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
        <span>No tasks found for this session.</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Session Tasks</span>
          <span className="text-xs text-muted-foreground">({sessionId.slice(0, 8)}...)</span>
          {projectEncodedName && (
            <button
              onClick={() => navigation.openLens('claude', 'transcript', `${projectEncodedName}/${sessionId}`)}
              className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary hover:bg-primary/20"
              title="View session transcript"
            >
              <FileText className="h-3 w-3" />
              Transcript
            </button>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {completedCount}/{totalCount} completed
        </span>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          {STATUS_ORDER.map((status) => {
            const groupTasks = grouped[status];
            if (!groupTasks || groupTasks.length === 0) return null;
            const config = STATUS_CONFIG[status];
            return (
              <div key={status}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {config.label}
                  </span>
                  <span className="text-xs text-muted-foreground">({groupTasks.length})</span>
                </div>
                <div className="flex flex-col gap-2">
                  {groupTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      isSelected={task.id === selectedTaskId}
                      cardRef={setTaskCardRef(task.id)}
                      onSelectTask={handleSelectTask}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
