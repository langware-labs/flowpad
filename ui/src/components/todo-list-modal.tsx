import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { CheckCircle, Circle, Target, FileText, Clock, Loader2, AlertCircle, Ban } from 'lucide-react';
import { TodoItem } from '@sdk';

interface TodoWithHierarchy extends TodoItem {
  isCurrent?: boolean;
  parent_id?: string;
  sub_todos?: TodoWithHierarchy[];
  level?: number; // For indentation
}

interface TodoListModalProps {
  isOpen: boolean;
  onClose: () => void;
  goal: string;
  expectedResult: string;
  todos: TodoWithHierarchy[];
  currentTodoId: string;
  totalTodoCount?: number;
}

// Get appropriate icon based on todo status
const getTodoIcon = (status: string, hasSubTodos: boolean) => {
  switch (status) {
    case 'completed':
      return <CheckCircle className="h-3 w-3 text-green-600" />;
    case 'executing':
      return <Loader2 className="h-3 w-3 animate-spin text-blue-600" />;
    case 'pending_sub_todos':
      return hasSubTodos ? <Clock className="h-3 w-3 text-orange-500" /> : <Circle className="h-3 w-3 text-gray-400" />;
    case 'failed':
      return <AlertCircle className="h-3 w-3 text-red-500" />;
    case 'blocked':
      return <Ban className="h-3 w-3 text-gray-500" />;
    case 'new_todo':
    default:
      return <Circle className="h-3 w-3 text-gray-400" />;
  }
};

// Get status text for display
const getStatusText = (status: string, hasSubTodos: boolean) => {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'executing':
      return 'Executing';
    case 'pending_sub_todos':
      return hasSubTodos ? 'Pending sub-tasks' : 'Pending';
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Blocked';
    case 'new_todo':
    default:
      return 'New';
  }
};

const TodoListModal: React.FC<TodoListModalProps> = ({
  isOpen,
  onClose,
  goal,
  expectedResult,
  todos,
  currentTodoId,
  totalTodoCount,
}) => {
  const [lastCompletedId, setLastCompletedId] = useState<string | null>(null);

  // Track completion changes for flash animation
  useEffect(() => {
    const newlyCompleted = todos.find((t) => t.status === 'completed' && t.id !== lastCompletedId);
    if (newlyCompleted) {
      setLastCompletedId(newlyCompleted.id);
    }
  }, [todos, lastCompletedId]);

  // Recursive function to render todos with hierarchy
  const renderTodoWithChildren = (todo: TodoWithHierarchy, level: number = 0) => {
    const isCurrent = todo.id === currentTodoId;
    const hasSubTodos = !!(todo.sub_todos && todo.sub_todos.length > 0);
    const isJustCompleted = todo.id === lastCompletedId && todo.status === 'completed';

    return (
      <div key={todo.id} className="space-y-1">
        <div
          className={`flex items-center gap-2 rounded-md p-2 transition-all duration-300 ${
            isJustCompleted
              ? 'animate-pulse border border-green-200 bg-green-100'
              : isCurrent
                ? 'border border-blue-200 bg-blue-100'
                : 'bg-gray-50 hover:bg-gray-100'
          }`}
          style={{
            marginLeft: `${level * 16}px`,
            borderLeft: level > 0 ? '2px solid #e5e7eb' : 'none',
            paddingLeft: level > 0 ? '8px' : '8px',
          }}
        >
          <div className="flex flex-shrink-0 items-center gap-2">
            {level > 0 && <div className="h-2 w-2 flex-shrink-0 rounded-full bg-gray-300"></div>}
            {getTodoIcon(todo.status, hasSubTodos)}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p
                className={`text-sm leading-tight ${
                  todo.status === 'completed'
                    ? 'text-gray-500 line-through'
                    : isCurrent
                      ? 'font-medium text-blue-900'
                      : 'text-gray-700'
                }`}
              >
                {todo.title}
              </p>

              {/* Status badge */}
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  todo.status === 'completed'
                    ? 'bg-green-100 text-green-700'
                    : todo.status === 'executing'
                      ? 'bg-blue-100 text-blue-700'
                      : todo.status === 'pending_sub_todos'
                        ? 'bg-orange-100 text-orange-700'
                        : todo.status === 'failed'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-700'
                }`}
              >
                {getStatusText(todo.status, hasSubTodos)}
              </span>
            </div>

            {isCurrent && <p className="mt-0.5 text-xs text-blue-600">⚡ Currently working on this task</p>}

            {/* Keywords chips on second line */}
            {todo.keywords && todo.keywords.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {todo.keywords.map((keyword, keywordIndex) => (
                  <span
                    key={keywordIndex}
                    className="inline-flex items-center rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-300"
                  >
                    {keyword}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Render sub-todos recursively */}
        {hasSubTodos && (
          <div className="space-y-1">
            {todo.sub_todos!.map((subTodo) => renderTodoWithChildren(subTodo, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-5 w-5 text-blue-600" />
            Goal & Todo List
          </DialogTitle>
          <DialogDescription>
            View your current goal, expected results, and track progress through your todo tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-auto">
          {/* Goal Section */}
          <div className="rounded-lg border bg-blue-50 p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Target className="h-4 w-4 text-blue-600" />
              Current Goal
            </h3>
            <p className="text-sm text-gray-700">{goal}</p>
          </div>

          {/* Expected Result Section */}
          <div className="rounded-lg border bg-green-50 p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <FileText className="h-4 w-4 text-green-600" />
              Expected Result
            </h3>
            <p className="text-sm text-gray-700">{expectedResult}</p>
          </div>

          {/* Todo List Section */}
          <div className="rounded-lg border p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <CheckCircle className="h-4 w-4 text-gray-600" />
              Todo List
            </h3>

            {/* Progress Summary */}
            <div className="mb-4 border-b pb-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Progress</span>
                <span className="font-medium">
                  {todos.filter((t) => t.completed).length} of {totalTodoCount || todos.length} completed
                </span>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-gray-200">
                <div
                  className="h-2 rounded-full bg-blue-600 transition-all duration-300"
                  style={{
                    width: `${totalTodoCount ? (todos.filter((t) => t.completed).length / totalTodoCount) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>

            <div className="space-y-1">
              {todos
                .filter((todo) => !todo.parent_id) // Only show root-level todos
                .map((todo) => renderTodoWithChildren(todo, 0))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default TodoListModal;
