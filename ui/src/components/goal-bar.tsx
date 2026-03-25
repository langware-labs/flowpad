import React, { useState, useMemo, useEffect } from 'react';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import {
  Target,
  ChevronDown,
  CheckCircle,
  Globe,
  Code,
  Server,
  Cloud,
  FileText,
  File,
  Database,
  Loader2,
  Clock,
} from 'lucide-react';
import { ResultType, ResultTypeMetadata, TodoItem } from '@sdk';

interface GoalBarProps {
  goal: string;
  currentTodo: string;
  todos: TodoItem[];
  totalTodoCount?: number;
  onExpandClick?: () => void;
}

// Map icon names to Lucide components
const iconComponents = {
  Globe,
  Code,
  Server,
  Cloud,
  FileText,
  File,
  Database,
};

interface GoalBarPropsExtended extends GoalBarProps {
  expectedResultTypes?: string[];
}

const GoalBar: React.FC<GoalBarPropsExtended> = ({
  goal,
  currentTodo,
  todos,
  totalTodoCount,
  onExpandClick,
  expectedResultTypes = [],
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [statusFlash, setStatusFlash] = useState(false);
  const [lastCompletedCount, setLastCompletedCount] = useState(0);

  // Use the goal from the unified process state (passed as prop)
  const displayGoal = goal;

  // Get current executing todo
  const currentExecutingTodo = todos.find((t) => t.status === 'executing');
  const currentPendingTodo = todos.find((t) => t.status === 'pending_sub_todos');
  const activeTodo = currentExecutingTodo || currentPendingTodo;

  // Dynamic status text based on current todo status
  const getStatusText = () => {
    if (currentExecutingTodo) {
      return 'Working on task';
    } else if (currentPendingTodo) {
      return 'Planning tasks';
    } else if (todos.length > 0 && todos.every((t) => t.status === 'completed')) {
      return 'All tasks completed';
    } else if (todos.length === 0) {
      return 'Waiting for tasks';
    } else {
      return 'Processing';
    }
  };

  // Dynamic status icon
  const getStatusIcon = () => {
    if (currentExecutingTodo) {
      return <Loader2 className="h-3 w-3 animate-spin text-blue-600" />;
    } else if (currentPendingTodo) {
      return <Clock className="h-3 w-3 text-orange-500" />;
    } else if (todos.length > 0 && todos.every((t) => t.status === 'completed')) {
      return <CheckCircle className="h-3 w-3 text-green-600" />;
    } else if (todos.length === 0) {
      return <Clock className="h-3 w-3 text-gray-400" />;
    } else {
      return <CheckCircle className="h-3 w-3" />;
    }
  };

  // Get the first expected result type, icon, and description
  const { ResultIcon, resultDescription } = useMemo(() => {
    if (expectedResultTypes.length === 0) {
      return { ResultIcon: Target, resultDescription: 'Goal target' };
    }

    const firstType = expectedResultTypes[0];

    // Check if firstType matches any ResultType enum value
    if (firstType && Object.values(ResultType).includes(firstType as ResultType)) {
      const metadata = ResultTypeMetadata[firstType as ResultType];
      const IconComponent = iconComponents[metadata.icon as keyof typeof iconComponents];
      return {
        ResultIcon: IconComponent || Target,
        resultDescription: metadata.description,
      };
    }

    return { ResultIcon: Target, resultDescription: 'Goal target' };
  }, [expectedResultTypes]);

  const handleExpandClick = () => {
    setIsExpanded(!isExpanded);
    onExpandClick?.();
  };

  const completedCount = todos.filter((todo) => todo.completed).length;
  const totalCount = totalTodoCount || todos.length;

  // Flash effect when task completes
  useEffect(() => {
    if (completedCount > lastCompletedCount) {
      setStatusFlash(true);
      setLastCompletedCount(completedCount);
      // Clear flash after animation
      setTimeout(() => setStatusFlash(false), 1000);
    }
  }, [completedCount, lastCompletedCount]);

  return (
    <div data-testid="goal-bar" className="border-b bg-background">
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="cursor-help">
                    <ResultIcon className="h-4 w-4 text-blue-600" />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{resultDescription}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span className="text-sm font-medium">Goal:</span>
          </div>

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium">{displayGoal}</span>
            <span className="text-gray-400">-</span>
            <div
              className={`flex items-center gap-2 transition-all duration-300 ${
                statusFlash ? 'animate-pulse rounded-full bg-green-100 px-2 py-0.5' : ''
              }`}
            >
              {getStatusIcon()}
              <span
                className={`truncate text-sm transition-colors duration-300 ${
                  currentExecutingTodo
                    ? 'font-medium text-blue-600'
                    : currentPendingTodo
                      ? 'text-orange-600'
                      : 'text-gray-600'
                }`}
              >
                {getStatusText()}: {activeTodo?.title || currentTodo}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-gray-500">
            <div
              className={`flex items-center gap-1 transition-all duration-300 ${
                statusFlash ? 'scale-110 text-green-600' : ''
              }`}
            >
              <CheckCircle className="h-3 w-3" />
              <span className="font-medium">
                {completedCount}/{totalCount}
              </span>
            </div>
          </div>
        </div>

        <Button variant="ghost" size="sm" onClick={handleExpandClick} className="ml-2 h-8 w-8 p-0">
          <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        </Button>
      </div>
    </div>
  );
};

export default GoalBar;
