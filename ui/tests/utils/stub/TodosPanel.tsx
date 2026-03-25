import { Flow, FlowStateProperty, TypeId } from '@sdk';
import { useProcessStateField } from '@src/hooks/flow-hooks';
import React, { useMemo } from 'react';

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  status: string;
  description?: string;
  sub_todos?: Todo[];
}

interface TodosPanelProps {
  flow: Flow | null;
}

/**
 * Renders the todos hierarchy from flow state
 * Uses useProcessStateField hook to get todos and current mode
 */
export const TodosPanel: React.FC<TodosPanelProps> = ({ flow }) => {
  const flowTypeId = useMemo(() => (flow ? new TypeId(Flow.type, flow.id) : null), [flow]);

  // Use hooks to get todos and chat_options from flow state
  // Access specific properties to avoid stateJson (which creates new objects)
  const { state: todos } = useProcessStateField(flowTypeId, FlowStateProperty.ROOT_TODO);
  const { state: chatOptions } = useProcessStateField(flowTypeId, FlowStateProperty.CHAT_OPTIONS);
  const currentMode = chatOptions?.mode?.value;
  const renderTodo = (todo: Todo, depth = 0) => {
    const isActive = todo.status === 'executing' || todo.status === 'pending_sub_todos';

    return (
      <div
        key={todo.id}
        data-testid={`todo-${todo.id}`}
        data-todo-status={todo.status}
        className={`p-2 rounded mb-2 ${depth > 0 ? 'ml-4' : ''} ${
          isActive ? 'bg-blue-50 border-l-4 border-blue-500' : todo.completed ? 'bg-green-50' : 'bg-gray-50'
        }`}
      >
        <div className="flex items-start gap-2">
          <div
            className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${
              todo.completed ? 'bg-green-500' : isActive ? 'bg-blue-500 animate-pulse' : 'bg-gray-300'
            }`}
          />

          <div className="flex-1">
            <div
              data-testid={`todo-title-${todo.id}`}
              className={`font-medium ${todo.completed ? 'line-through text-gray-500' : ''}`}
            >
              {todo.title}
            </div>

            {todo.description && (
              <div data-testid={`todo-description-${todo.id}`} className="text-sm text-gray-600 mt-1">
                {todo.description}
              </div>
            )}

            <div data-testid={`todo-status-${todo.id}`} className="text-xs text-gray-500 mt-1">
              Status: {todo.status}
            </div>
          </div>
        </div>

        {/* Render sub-todos */}
        {todo.sub_todos && todo.sub_todos.length > 0 && (
          <div className="mt-2">{todo.sub_todos.map((subTodo) => renderTodo(subTodo, depth + 1))}</div>
        )}
      </div>
    );
  };

  if (!todos) {
    return (
      <div data-testid="todos-panel-empty" className="p-4 text-gray-500 text-center">
        No todos available
      </div>
    );
  }

  return (
    <div data-testid="todos-panel" className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">Tasks</h3>
        {currentMode && (
          <span data-testid="current-mode" className="text-xs bg-gray-200 px-2 py-1 rounded">
            {currentMode}
          </span>
        )}
      </div>

      <div data-testid="todos-list">{renderTodo(todos)}</div>

      {/* Summary */}
      <div data-testid="todos-summary" className="mt-4 pt-4 border-t text-xs text-gray-600">
        <div>
          Total tasks: <span data-testid="total-tasks">1</span>
        </div>
        <div>
          Status: <span data-testid="root-status">{todos.status}</span>
        </div>
      </div>
    </div>
  );
};
