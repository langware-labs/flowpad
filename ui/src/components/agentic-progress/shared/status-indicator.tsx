import { ProcessorStatus } from '@sdk';
import { Check, Circle, Loader2, Pause, AlertCircle, XCircle } from 'lucide-react';
import { cn } from '@src/lib/utils';

interface StatusIndicatorProps {
  status: ProcessorStatus;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const statusConfig: Record<
  ProcessorStatus,
  {
    icon: typeof Check;
    color: string;
    bgColor: string;
    label: string;
    animate?: boolean;
  }
> = {
  [ProcessorStatus.IDLE]: {
    icon: Circle,
    color: 'text-gray-400',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
    label: 'Ready',
  },
  [ProcessorStatus.RUNNING]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: 'Running',
    animate: true,
  },
  [ProcessorStatus.STEPPING]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: 'Stepping',
    animate: true,
  },
  [ProcessorStatus.PAUSED]: {
    icon: Pause,
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-100 dark:bg-yellow-900/30',
    label: 'Paused',
  },
  [ProcessorStatus.COMPLETE]: {
    icon: Check,
    color: 'text-green-500',
    bgColor: 'bg-green-100 dark:bg-green-900/30',
    label: 'Complete',
  },
  [ProcessorStatus.ERROR]: {
    icon: AlertCircle,
    color: 'text-red-500',
    bgColor: 'bg-red-100 dark:bg-red-900/30',
    label: 'Error',
  },
  [ProcessorStatus.INTERRUPTED]: {
    icon: XCircle,
    color: 'text-gray-500',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
    label: 'Interrupted',
  },
};

const sizeConfig = {
  sm: { icon: 'h-3 w-3', text: 'text-xs', gap: 'gap-1' },
  md: { icon: 'h-4 w-4', text: 'text-sm', gap: 'gap-1.5' },
  lg: { icon: 'h-5 w-5', text: 'text-base', gap: 'gap-2' },
};

export function StatusIndicator({ status, showLabel = false, size = 'md', className }: StatusIndicatorProps) {
  const config = statusConfig[status];
  const sizes = sizeConfig[size];
  const Icon = config.icon;

  return (
    <div className={cn('flex items-center', sizes.gap, className)}>
      <Icon className={cn(sizes.icon, config.color, config.animate && 'animate-spin')} />
      {showLabel && <span className={cn(sizes.text, config.color, 'font-medium')}>{config.label}</span>}
    </div>
  );
}

export function StatusBadge({ status, className }: { status: ProcessorStatus; className?: string }) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5', config.bgColor, className)}>
      <Icon className={cn('h-3.5 w-3.5', config.color, config.animate && 'animate-spin')} />
      <span className={cn('text-xs font-medium', config.color)}>{config.label}</span>
    </div>
  );
}
