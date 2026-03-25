import { InstructionStatus } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Progress } from '@src/components/ui/progress';
import { Check, ChevronDown, ChevronRight, Circle, FileCode, Loader2, SkipForward, X } from 'lucide-react';
import type { Instruction } from '../types';

interface InstructionItemProps {
  instruction: Instruction;
  isCurrent: boolean;
  onRetry?: (instructionId: string) => void;
  onSkip?: (instructionId: string) => void;
  onToggleExpand?: (instructionId: string) => void;
}

export function InstructionItem({ instruction, isCurrent, onRetry, onSkip, onToggleExpand }: InstructionItemProps) {
  const indentPx = instruction.depth * 20;
  const isFlowCall = instruction.type === 'call';
  const hasChildren = instruction.children.length > 0;
  const canExpand = hasChildren || (isFlowCall && instruction.status === InstructionStatus.EXECUTING);

  const getStatusIcon = () => {
    switch (instruction.status) {
      case InstructionStatus.COMPLETED:
        return <Check className="h-4 w-4 text-green-500" />;
      case InstructionStatus.EXECUTING:
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
      case InstructionStatus.FAILED:
        return <X className="h-4 w-4 text-red-500" />;
      case InstructionStatus.SKIPPED:
        return <SkipForward className="h-4 w-4 text-gray-400" />;
      default:
        return <Circle className="h-4 w-4 text-gray-300" />;
    }
  };

  const getChildProgress = () => {
    if (!instruction.childProgress) return null;
    const { total, completed, failed } = instruction.childProgress;
    if (total === 0) return null;
    const percent = (completed / total) * 100;
    return (
      <div className="flex items-center gap-2">
        <Progress value={percent} className="h-1 w-16" />
        <span className="text-xs text-muted-foreground">
          {completed}/{total}
          {failed > 0 && <span className="text-red-500"> ({failed} failed)</span>}
        </span>
      </div>
    );
  };

  return (
    <div>
      <div
        className={`flex items-start gap-2 border-b p-2 ${
          isCurrent ? 'bg-blue-50 dark:bg-blue-950' : 'hover:bg-gray-50 dark:hover:bg-gray-900'
        }`}
        style={{ paddingLeft: `${8 + indentPx}px` }}
      >
        {canExpand ? (
          <button
            onClick={() => onToggleExpand?.(instruction.id)}
            className="flex-shrink-0 rounded p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            {instruction.expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        ) : (
          <div className="w-[18px] flex-shrink-0" />
        )}

        <div className="flex-shrink-0 pt-0.5">{getStatusIcon()}</div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{instruction.id}:</span>
            <span className="truncate text-sm">{instruction.content}</span>
          </div>

          {isFlowCall && instruction.href && (
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <FileCode className="h-3 w-3" />
              <span>{instruction.href}</span>
            </div>
          )}

          {isFlowCall && instruction.childProgress && <div className="mt-1">{getChildProgress()}</div>}

          {instruction.error && <div className="mt-1 text-xs text-red-500">{instruction.error}</div>}
        </div>

        {instruction.status === InstructionStatus.FAILED && (
          <div className="flex gap-1">
            {onRetry && (
              <Button size="sm" variant="ghost" onClick={() => onRetry(instruction.id)} className="h-6 text-xs">
                Retry
              </Button>
            )}
            {onSkip && (
              <Button size="sm" variant="ghost" onClick={() => onSkip(instruction.id)} className="h-6 text-xs">
                Skip
              </Button>
            )}
          </div>
        )}
      </div>

      {instruction.expanded && hasChildren && (
        <div>
          {instruction.children.map((child) => (
            <InstructionItem
              key={child.id}
              instruction={child}
              isCurrent={isCurrent && child.status === InstructionStatus.EXECUTING}
              onRetry={onRetry}
              onSkip={onSkip}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}
