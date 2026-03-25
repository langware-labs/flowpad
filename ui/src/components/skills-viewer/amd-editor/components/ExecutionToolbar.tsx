import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import { useAMDEditor } from '../AMDEditorContext';

interface ExecutionToolbarProps {
  /** Whether the work queue panel is collapsed */
  isCollapsed?: boolean;
  /** Called to toggle collapse/expand of the work queue panel */
  onToggleCollapse?: () => void;
}

/**
 * ExecutionToolbar - Queue header for AMD Editor (the future)
 *
 * Distinct from status bar (present) - shows pending/queued instructions.
 * Uses blue/indigo tones to represent "future" vs amber/green for "present/past".
 * The "WORK QUEUE" label is clickable to collapse/expand the panel.
 */
export function ExecutionToolbar({ isCollapsed = false, onToggleCollapse }: ExecutionToolbarProps) {
  const { elements, showCompleted, setShowCompleted, getInstructionStatus } = useAMDEditor();

  // Count instructions by status
  const completedCount = elements.filter((el) => {
    const instructionId = el.element.attributes.id || '';
    return getInstructionStatus(instructionId) === 'completed';
  }).length;

  const totalCount = elements.filter((el) => el.element.attributes.id).length;
  const pendingCount = totalCount - completedCount;

  return (
    <div className="flex items-center gap-3 border-b border-indigo-200 bg-indigo-50 px-3 py-1.5 font-mono text-[11px] dark:border-indigo-900/30 dark:bg-indigo-950/20">
      {/* Work Queue label - clickable to toggle collapse/expand */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onToggleCollapse}
            className="flex items-center gap-1.5 transition-colors hover:text-indigo-700 dark:hover:text-indigo-300"
            disabled={!onToggleCollapse}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 text-indigo-500 transition-transform duration-200 dark:text-indigo-400 ${
                isCollapsed ? '' : 'rotate-90'
              }`}
            />
            <span className="text-[10px] uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              work queue
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono text-xs">
          {isCollapsed ? 'Expand work queue' : 'Collapse work queue'}
        </TooltipContent>
      </Tooltip>

      {/* Separator */}
      <span className="text-indigo-300 dark:text-indigo-900/50">│</span>

      {/* Pending count */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex cursor-default items-center gap-1">
            <span className="text-indigo-600 dark:text-indigo-400">{pendingCount}</span>
            <span className="text-[10px] text-zinc-500 dark:text-zinc-600">pending</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono text-xs">
          {pendingCount} instruction{pendingCount !== 1 ? 's' : ''} waiting to execute
        </TooltipContent>
      </Tooltip>

      {/* Completed count (if any) */}
      {completedCount > 0 && (
        <>
          <span className="text-indigo-300 dark:text-indigo-900/50">│</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex cursor-default items-center gap-1">
                <span className="text-zinc-500 dark:text-zinc-600">{completedCount}</span>
                <span className="text-[10px] text-zinc-400 dark:text-zinc-700">done</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="font-mono text-xs">
              {completedCount} instruction{completedCount !== 1 ? 's' : ''} completed
            </TooltipContent>
          </Tooltip>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Toggle completed visibility - always visible */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            className={`transition-colors ${
              completedCount > 0
                ? 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300'
                : 'text-zinc-300 dark:text-zinc-700'
            }`}
            disabled={completedCount === 0}
          >
            {showCompleted ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono text-xs">
          {completedCount === 0 ? 'No completed instructions' : showCompleted ? 'Hide completed' : 'Show completed'}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
