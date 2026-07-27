/**
 * Todo-related models matching the server Pydantic models.
 */

export enum TodoStatus {
  NEW = 'new_todo',
  PENDING_SUB_TODOS = 'pending_sub_todos',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  BLOCKED = 'blocked',
}

export interface TodoResult {
  success: boolean;
  artifacts: string[];
  output_data: Record<string, any>;
  error_message?: string;
  execution_time?: number;
}

export interface Todo {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  fail_count: number;
  keywords: string[];
  priority: number;
  atomic: boolean;

  // Hierarchy
  parent_id?: string;
  sub_todos: Todo[];

  // Dependencies and tests
  dependencies: string[];
  test_todo_ids: string[];

  // Execution context
  input_parameters: Record<string, any>;
  result?: TodoResult;

  // Semantic context
  expected_artifacts: string[];

  // Artifacts referenced by this todo
  artifacts: Record<string, any>;
}

/**
 * Simplified Todo interface for UI components
 * Contains only the fields needed for display
 */
export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  status: string;
  keywords: string[];
  description?: string;
}

/**
 * Utility to convert Todo to TodoItem for UI display
 */
export function todoToTodoItem(todo: Todo): TodoItem {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.status === TodoStatus.COMPLETED,
    status: todo.status,
    keywords: todo.keywords,
    description: todo.description,
  };
}

/**
 * Todo focus event data containing the entire todo tree
 */
export interface TodoFocusArgs {
  /** The complete root todo with all sub_todos */
  root_todo: Todo;
}

export type TodoData = TodoFocusArgs;
