import { Button } from '@src/components/ui/button';
import { ChevronRight, GripVertical, Trash2 } from 'lucide-react';
import { FusionSpinner } from '@src/components/icons/FusionSpinner';
import { InstructionStatus, useAMDEditor } from '../AMDEditorContext';
import { AMDElement, BLOCK_CONFIGS, isContainerType } from '../types';

interface BlockWrapperProps {
  element: AMDElement;
  depth: number;
  children: React.ReactNode;
}

/**
 * Terminal-style status indicator
 */
function StatusIndicator({ status }: { status: InstructionStatus }) {
  switch (status) {
    case 'executing':
      return <FusionSpinner size="xs" />;
    case 'completed':
      return <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-500">✓</span>;
    case 'error':
      return <span className="font-mono text-[10px] text-red-600 dark:text-red-500">✗</span>;
    default:
      return <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-600">○</span>;
  }
}

/**
 * Get terminal-style border based on execution status
 */
function getStatusStyles(status: InstructionStatus): string {
  switch (status) {
    case 'executing':
      return 'border-l-2 border-l-amber-500 bg-amber-50 dark:border-l-amber-400 dark:bg-amber-950/20';
    case 'completed':
      return 'border-l-2 border-l-emerald-500/50 bg-emerald-50 dark:border-l-emerald-600/50 dark:bg-emerald-950/10';
    case 'error':
      return 'border-l-2 border-l-red-500 bg-red-50 dark:bg-red-950/20';
    default:
      return 'border-l-2 border-l-transparent';
  }
}

export function BlockWrapper({ element, depth, children }: BlockWrapperProps) {
  const {
    selectedId,
    selectElement,
    expandedIds,
    toggleExpanded,
    deleteElement,
    moveElement,
    getInstructionStatus,
    showCompleted,
  } = useAMDEditor();

  const config = BLOCK_CONFIGS[element.element.elementType];
  const isSelected = selectedId === element.localId;
  const isContainer = isContainerType(element.element.elementType);
  const isExpanded = expandedIds.has(element.localId);

  // Get instruction ID from element attributes (for 'do' blocks with id)
  const instructionId = element.element.attributes.id || '';
  const executionStatus = getInstructionStatus(instructionId);
  const statusStyles = getStatusStyles(executionStatus);
  const isCompleted = executionStatus === 'completed';

  // Hide completed instructions when showCompleted is false
  if (!showCompleted && isCompleted) {
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectElement(element.localId);
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleExpanded(element.localId);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteElement(element.localId);
  };

  const handleMoveUp = (e: React.MouseEvent) => {
    e.stopPropagation();
    moveElement(element.localId, 'up');
  };

  const handleMoveDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    moveElement(element.localId, 'down');
  };

  // Terminal-style type colors (muted, professional)
  const typeColors: Record<string, string> = {
    do: 'text-blue-600 dark:text-blue-400',
    set: 'text-violet-600 dark:text-violet-400',
    if: 'text-orange-600 dark:text-orange-400',
    each: 'text-emerald-600 dark:text-emerald-400',
    block: 'text-zinc-500 dark:text-zinc-400',
    ui: 'text-cyan-600 dark:text-cyan-400',
    call: 'text-teal-600 dark:text-teal-400',
    text: 'text-zinc-500',
  };

  const typeColor = typeColors[element.element.elementType] || 'text-zinc-500';

  // Styling for completed instructions when visible: dimmed
  const completedVisualStyles = showCompleted && isCompleted ? 'opacity-40' : '';

  return (
    <div
      className={`group relative font-mono transition-all ${statusStyles} ${
        isSelected ? 'bg-zinc-200/60 dark:bg-zinc-800/60' : 'hover:bg-zinc-100/50 dark:hover:bg-zinc-900/50'
      } ${completedVisualStyles}`}
      style={{ marginLeft: depth > 0 ? '12px' : 0 }}
      onClick={handleClick}
    >
      {/* Single row layout - condensed terminal style */}
      <div className="flex items-start gap-1.5 px-2 py-1">
        {/* Left side: drag handle (hover only) */}
        <GripVertical className="mt-0.5 h-3 w-3 shrink-0 cursor-grab text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 dark:text-zinc-700" />

        {/* Status indicator */}
        <div className="mt-0.5 w-3 shrink-0">
          <StatusIndicator status={executionStatus} />
        </div>

        {/* Expand toggle for containers */}
        {isContainer ? (
          <button
            onClick={handleToggleExpand}
            className="mt-0.5 shrink-0 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
          >
            <ChevronRight className={`h-3 w-3 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <div className="w-3 shrink-0" />
        )}

        {/* Type label - terminal command style */}
        <span className={`mt-px shrink-0 text-[10px] uppercase tracking-wider ${typeColor}`}>{config.label}</span>

        {/* Separator */}
        <span className="mt-px shrink-0 text-zinc-300 dark:text-zinc-700">│</span>

        {/* Content area */}
        <div
          className={`min-w-0 flex-1 text-[12px] text-zinc-700 dark:text-zinc-300 ${showCompleted && isCompleted ? 'text-zinc-400 line-through dark:text-zinc-600' : ''}`}
        >
          {children}
        </div>

        {/* Actions - only on hover, terminal style */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 text-zinc-400 hover:bg-transparent hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
            onClick={handleMoveUp}
            title="Move up"
          >
            <ChevronRight className="h-3 w-3 -rotate-90" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 text-zinc-400 hover:bg-transparent hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
            onClick={handleMoveDown}
            title="Move down"
          >
            <ChevronRight className="h-3 w-3 rotate-90" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 text-zinc-400 hover:bg-transparent hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400"
            onClick={handleDelete}
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Children for containers - terminal tree style */}
      {isContainer && isExpanded && element.children.length > 0 && (
        <div className="ml-5 border-l border-zinc-200 pb-0.5 dark:border-zinc-800" />
      )}
    </div>
  );
}
