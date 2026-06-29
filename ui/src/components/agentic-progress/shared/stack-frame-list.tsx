import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { StackFrame } from '@sdk';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { cn } from '@src/lib/utils';
import { ChevronRight, Layers, Phone, Box, GitBranch, RotateCw } from 'lucide-react';
import { LoopProgress } from './loop-progress';
import { VariablesInspector } from './variables-inspector';

interface StackFrameListProps {
  stack: StackFrame[];
  className?: string;
}

const frameTypeConfig: Record<StackFrame['type'], { icon: typeof Phone; label: string; color: string }> = {
  call: { icon: Phone, label: 'call', color: 'text-blue-500' },
  block: { icon: Box, label: 'block', color: 'text-gray-500' },
  if: { icon: GitBranch, label: 'if', color: 'text-purple-500' },
  each: { icon: RotateCw, label: 'each', color: 'text-orange-500' },
};

/**
 * Displays the execution call stack with frame details
 */
export function StackFrameList({ stack, className }: StackFrameListProps) {
  const [isOpen, setIsOpen] = useState(true);

  if (stack.length === 0) {
    return null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
        <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
        <Layers className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium"><Trans>Stack Trace</Trans></span>
        <span className="text-xs text-muted-foreground"><Trans>(depth: {stack.length})</Trans></span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-4 pt-1">
        <div className="space-y-1 border-l-2 border-border pl-3">
          {stack.map((frame, idx) => (
            <StackFrameItem key={frame.frameId} frame={frame} isLast={idx === stack.length - 1} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface StackFrameItemProps {
  frame: StackFrame;
  isLast: boolean;
}

function StackFrameItem({ frame, isLast }: StackFrameItemProps) {
  const [showDetails, setShowDetails] = useState(isLast);
  const { t } = useLingui();
  const config = frameTypeConfig[frame.type];
  const Icon = config.icon;
  const hasIterator = frame.type === 'each' && frame.iteratorIndex !== undefined && frame.iteratorTotal !== undefined;
  const hasLocalVars = Object.keys(frame.localVariables).length > 0;

  return (
    <div className={cn('relative', isLast && 'rounded bg-muted/30')}>
      {/* Frame header */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted/50"
      >
        <ChevronRight
          className={cn('h-3 w-3 text-muted-foreground transition-transform', showDetails && 'rotate-90')}
        />
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium',
            config.color,
            'bg-current/10',
          )}
        >
          <Icon className="h-3 w-3" />
          {config.label}
        </span>
        {frame.sourceVfsPath && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {getFileName(frame.sourceVfsPath)}:{frame.index + 1}
          </span>
        )}
        {hasIterator && (
          <span className="ml-auto text-xs text-muted-foreground">
            ({frame.iteratorIndex! + 1}/{frame.iteratorTotal})
          </span>
        )}
      </button>

      {/* Frame details */}
      {showDetails && (
        <div className="space-y-2 px-2 pb-2 pl-7">
          {/* Loop progress bar for 'each' frames */}
          {hasIterator && (
            <LoopProgress
              current={frame.iteratorIndex! + 1}
              total={frame.iteratorTotal!}
              name={frame.iteratorName}
              variant="bar"
            />
          )}

          {/* Local variables */}
          {hasLocalVars && (
            <VariablesInspector variables={frame.localVariables} title={t`Local Variables`} defaultOpen={isLast} />
          )}

          {/* Frame metadata */}
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {frame.sourceVfsPath && (
              <div className="flex gap-2">
                <span className="text-muted-foreground/60"><Trans>Source:</Trans></span>
                <span className="font-mono">{frame.sourceVfsPath}</span>
              </div>
            )}
            <div className="flex gap-2">
              <span className="text-muted-foreground/60"><Trans>Index:</Trans></span>
              <span>{frame.index}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
