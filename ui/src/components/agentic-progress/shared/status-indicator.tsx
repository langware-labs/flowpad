import { ProcessStatus } from '@sdk';
import { Check, Circle, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@src/lib/utils';

interface StatusIndicatorProps {
  status: ProcessStatus;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const statusConfig: Record<
  ProcessStatus,
  {
    icon: typeof Check;
    color: string;
    bgColor: string;
    label: string;
    animate?: boolean;
  }
> = {
  [ProcessStatus.NEW]: {
    icon: Circle,
    color: 'text-gray-400',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
    label: 'New',
  },
  [ProcessStatus.STARTING]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: 'Starting',
    animate: true,
  },
  [ProcessStatus.LIVE]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: 'Running',
    animate: true,
  },
  [ProcessStatus.STOPPING]: {
    icon: Loader2,
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-100 dark:bg-yellow-900/30',
    label: 'Stopping',
    animate: true,
  },
  [ProcessStatus.STOPPED]: {
    icon: Check,
    color: 'text-green-500',
    bgColor: 'bg-green-100 dark:bg-green-900/30',
    label: 'Complete',
  },
  [ProcessStatus.FAILED]: {
    icon: AlertCircle,
    color: 'text-red-500',
    bgColor: 'bg-red-100 dark:bg-red-900/30',
    label: 'Error',
  },
};

const sizeConfig = {
  sm: { icon: 'h-3 w-3', text: 'text-xs', gap: 'gap-1' },
  md: { icon: 'h-4 w-4', text: 'text-sm', gap: 'gap-1.5' },
  lg: { icon: 'h-5 w-5', text: 'text-base', gap: 'gap-2' },
};

export function StatusIndicator({ status, showLabel = false, size = 'md', className }: StatusIndicatorProps) {
  const config = statusConfig[status] ?? statusConfig[ProcessStatus.NEW];
  const sizes = sizeConfig[size];
  const Icon = config.icon;

  return (
    <div className={cn('flex items-center', sizes.gap, className)}>
      <Icon className={cn(sizes.icon, config.color, config.animate && 'animate-spin')} />
      {showLabel && <span className={cn(sizes.text, config.color, 'font-medium')}>{config.label}</span>}
    </div>
  );
}

export function StatusBadge({ status, className }: { status: ProcessStatus; className?: string }) {
  const config = statusConfig[status] ?? statusConfig[ProcessStatus.NEW];
  const Icon = config.icon;

  return (
    <div className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5', config.bgColor, className)}>
      <Icon className={cn('h-3.5 w-3.5', config.color, config.animate && 'animate-spin')} />
      <span className={cn('text-xs font-medium', config.color)}>{config.label}</span>
    </div>
  );
}
