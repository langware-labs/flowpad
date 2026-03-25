import { Progress } from '@src/components/ui/progress';
import { cn } from '@src/lib/utils';
import { RotateCw } from 'lucide-react';

interface LoopProgressProps {
  current: number;
  total: number;
  name?: string;
  variant?: 'inline' | 'bar';
  className?: string;
}

/**
 * Displays loop/iterator progress from an 'each' instruction
 */
export function LoopProgress({ current, total, name = 'item', variant = 'inline', className }: LoopProgressProps) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  if (variant === 'inline') {
    return (
      <span className={cn('inline-flex items-center gap-1 text-muted-foreground', className)}>
        <RotateCw className="h-3 w-3" />
        <span className="text-xs">
          {name} {current}/{total}
        </span>
      </span>
    );
  }

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <RotateCw className="h-3 w-3" />
          <span>
            Loop: {name} ({current}/{total})
          </span>
        </span>
        <span className="text-muted-foreground">{percent}%</span>
      </div>
      <Progress value={percent} className="h-1.5" />
    </div>
  );
}
