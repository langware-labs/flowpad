import { useProjectTasks } from '@src/hooks/use-project-tasks';
import { getStatusBadgeClass } from '@src/components/task-bar/task-utils';
import { isTypeId, Task, TypeId } from '@sdk';
import { Card, CardDescription, CardHeader, CardTitle } from '@src/components/ui/card';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { Hand } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { TaskDetail } from './TaskDetail';

export function AssistanceViewer() {
  const { navigation } = useDockNavigation();
  const { currentContext } = useViewerStore();

  // Derive active task ID from currentContext (synced from URL in FlowPage)
  const activeTaskId = useMemo(() => {
    if (currentContext?.codeRef?.path) {
      // If we have a selected task in state, use it; otherwise null
      const taskTypeIdStr = currentContext.codeRef.path;
      if (!isTypeId(taskTypeIdStr)) return null;
      const taskTypeId = new TypeId(taskTypeIdStr);
      if (taskTypeId.type !== Task.type) {
        console.error('AssistanceViewer context path is not a task type-id', taskTypeIdStr);
        return null;
      }
      return taskTypeId.id;
    }
    return null;
  }, [currentContext]);

  // Fetch tasks for current project using the custom hook
  const { data: tasks, isLoading, error } = useProjectTasks();

  const handleTaskClick = useCallback(
    (taskTypeId: TypeId) => {
      navigation.openDock(DockPointer.forAssistance(taskTypeId));
    },
    [navigation],
  );

  const handleBackToList = useCallback(() => {
    navigation.openDock(DockPointer.forAssistance());
  }, [navigation]);

  // Render sidebar with task list
  const renderSidebar = () => (
    <div className="flex h-full w-80 flex-col border-r bg-background">
      <div className="flex h-[52px] items-center justify-between border-b bg-muted/50 px-3">
        <h2 className="text-sm font-semibold">Expert Assistance</h2>
      </div>

      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">Loading tasks...</div>
        ) : error ? (
          <div className="p-4 text-center">
            <Hand className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">Failed to load tasks</p>
          </div>
        ) : !tasks || tasks.length === 0 ? (
          <div className="p-4 text-center">
            <Hand className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">No assistance requests yet</p>
            <p className="mt-1 text-xs text-muted-foreground/70">Use &quot;Send to Expert&quot; to create a task</p>
          </div>
        ) : (
          <div className="space-y-2 p-2">
            {tasks.map((task) => {
              const isActive = activeTaskId === task.id;
              return (
                <Card
                  key={task.id}
                  className={`cursor-pointer transition-colors ${
                    isActive ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                  }`}
                  onClick={() => handleTaskClick(task.typeId)}
                >
                  <CardHeader className="p-3">
                    <CardTitle className="line-clamp-2 text-sm font-medium">{task.title}</CardTitle>
                    {task.status && (
                      <CardDescription className="text-xs">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 ${getStatusBadgeClass(task.status)}`}
                        >
                          {task.status}
                        </span>
                      </CardDescription>
                    )}
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );

  // Render main content area
  const renderContent = () => {
    if (!activeTaskId || !tasks) {
      return (
        <div className="flex h-full flex-1 flex-col bg-background">
          <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
            <div className="flex-1">
              <h3 className="text-sm font-medium text-muted-foreground">No Task Selected</h3>
            </div>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <Hand className="h-16 w-16 text-muted-foreground/50" />
            <p className="mt-4 text-lg text-muted-foreground">Select a task</p>
            <p className="mt-2 text-sm text-muted-foreground">Choose a task from the sidebar to view details</p>
          </div>
        </div>
      );
    }

    const selectedTask = tasks.find((t) => t.id === activeTaskId);
    if (!selectedTask) {
      return (
        <div className="flex h-full flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Task not found</p>
        </div>
      );
    }

    return <TaskDetail task={selectedTask} onBack={handleBackToList} />;
  };

  return (
    <div className="flex h-full w-full bg-background">
      {renderSidebar()}
      {renderContent()}
    </div>
  );
}
