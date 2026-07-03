import {
  getDisplayStatus,
  ProcessStatus,
  PROCESS_STATUS_LABEL,
  type StatusBearingProcess,
  WorkerStatus,
  WORKER_STATUS_LABEL,
} from '@sdk';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CircleHelp,
  Circle,
  Clock,
  Hourglass,
  Loader2,
  MessageCircle,
  Moon,
  Square,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@src/lib/utils';

interface StatusIndicatorProps {
  status: ProcessStatus;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

interface StatusConfig {
  icon: LucideIcon;
  color: string;
  bgColor: string;
  label: string;
  animate?: boolean;
}

/**
 * Config for each ProcessStatus — app/user-level lifecycle.
 *
 * Canonical source of truth for status display. Every surface that shows
 * "this process is running / starting / complete / …" resolves here.
 */
export const processStatusConfig: Record<ProcessStatus, StatusConfig> = {
  [ProcessStatus.NEW]: {
    icon: Circle,
    color: 'text-gray-400',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
    label: PROCESS_STATUS_LABEL[ProcessStatus.NEW],
  },
  [ProcessStatus.STARTING]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: PROCESS_STATUS_LABEL[ProcessStatus.STARTING],
    animate: true,
  },
  // Legacy stored value — should never reach the wire, but keep a config so the
  // exhaustive Record typechecks and any stray legacy payload still renders.
  [ProcessStatus.RUNNING]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: PROCESS_STATUS_LABEL[ProcessStatus.RUNNING],
    animate: true,
  },
  // Live + idle: the worker can take the next prompt. Reads as "Idle".
  [ProcessStatus.READY]: {
    icon: Circle,
    color: 'text-gray-400',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
    label: PROCESS_STATUS_LABEL[ProcessStatus.READY],
  },
  // Live + a turn in flight. Reads as "Working" with a spinner.
  [ProcessStatus.BUSY]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: PROCESS_STATUS_LABEL[ProcessStatus.BUSY],
    animate: true,
  },
  [ProcessStatus.STOPPING]: {
    icon: Loader2,
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-100 dark:bg-yellow-900/30',
    label: PROCESS_STATUS_LABEL[ProcessStatus.STOPPING],
    animate: true,
  },
  [ProcessStatus.STOPPED]: {
    icon: Check,
    color: 'text-green-500',
    bgColor: 'bg-green-100 dark:bg-green-900/30',
    label: PROCESS_STATUS_LABEL[ProcessStatus.STOPPED],
  },
  [ProcessStatus.FAILED]: {
    icon: AlertCircle,
    color: 'text-red-500',
    bgColor: 'bg-red-100 dark:bg-red-900/30',
    label: PROCESS_STATUS_LABEL[ProcessStatus.FAILED],
  },
};

/**
 * Config for each WorkerStatus — expert-level state of the worker inside the process.
 *
 * Rendered by surfaces that want the fine-grained "Thinking / Using tool / …"
 * signal (interactive terminal, live workflow, session analysis). Falls back to
 * ``processStatusConfig`` on any surface that doesn't care.
 */
export const workerStatusConfig: Record<WorkerStatus, StatusConfig> = {
  [WorkerStatus.INITIALIZING]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.INITIALIZING],
    animate: true,
  },
  [WorkerStatus.IDLE]: {
    icon: Circle,
    color: 'text-gray-400',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
    label: WORKER_STATUS_LABEL[WorkerStatus.IDLE],
  },
  [WorkerStatus.WORKING]: {
    icon: Hourglass,
    color: 'text-blue-400',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.WORKING],
    animate: true,
  },
  [WorkerStatus.THINKING]: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.THINKING],
    animate: true,
  },
  [WorkerStatus.TOOL_CALL]: {
    icon: Wrench,
    color: 'text-purple-500',
    bgColor: 'bg-purple-100 dark:bg-purple-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.TOOL_CALL],
    animate: true,
  },
  [WorkerStatus.TOOL_RUNNING]: {
    icon: Loader2,
    color: 'text-purple-500',
    bgColor: 'bg-purple-100 dark:bg-purple-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.TOOL_RUNNING],
    animate: true,
  },
  [WorkerStatus.COMPLETE]: {
    icon: Check,
    color: 'text-green-500',
    bgColor: 'bg-green-100 dark:bg-green-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.COMPLETE],
  },
  [WorkerStatus.INTERRUPTED]: {
    icon: Square,
    color: 'text-amber-500',
    bgColor: 'bg-amber-100 dark:bg-amber-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.INTERRUPTED],
  },
  [WorkerStatus.INACTIVE]: {
    icon: Moon,
    color: 'text-gray-400',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
    label: WORKER_STATUS_LABEL[WorkerStatus.INACTIVE],
  },
  [WorkerStatus.PENDING_USER]: {
    icon: MessageCircle,
    color: 'text-sky-500',
    bgColor: 'bg-sky-100 dark:bg-sky-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.PENDING_USER],
  },
  [WorkerStatus.ERROR]: {
    icon: AlertCircle,
    color: 'text-red-500',
    bgColor: 'bg-red-100 dark:bg-red-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.ERROR],
  },
  [WorkerStatus.API_ERROR]: {
    icon: AlertTriangle,
    color: 'text-amber-500',
    bgColor: 'bg-amber-100 dark:bg-amber-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.API_ERROR],
    animate: true,
  },
  [WorkerStatus.API_TIMEOUT]: {
    icon: Clock,
    color: 'text-red-500',
    bgColor: 'bg-red-100 dark:bg-red-900/30',
    label: WORKER_STATUS_LABEL[WorkerStatus.API_TIMEOUT],
  },
  [WorkerStatus.UNKNOWN]: {
    icon: CircleHelp,
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
    label: WORKER_STATUS_LABEL[WorkerStatus.UNKNOWN],
  },
};

function isWorkerStatus(v: unknown): v is WorkerStatus {
  return (
    typeof v === 'string' &&
    (Object.values(WorkerStatus) as string[]).includes(v as string)
  );
}

function isProcessStatus(v: unknown): v is ProcessStatus {
  return (
    typeof v === 'string' &&
    (Object.values(ProcessStatus) as string[]).includes(v as string)
  );
}

function resolveConfig(value: ProcessStatus | WorkerStatus): StatusConfig {
  if (isWorkerStatus(value)) return workerStatusConfig[value];
  if (isProcessStatus(value)) return processStatusConfig[value];
  return processStatusConfig[ProcessStatus.NEW];
}

/** Label for the display status of a process (worker when LIVE, lifecycle otherwise). */
export function getStatusLabel(p: StatusBearingProcess): string {
  const display = getDisplayStatus(p);
  if (!display) return processStatusConfig[ProcessStatus.NEW].label;
  return resolveConfig(display).label;
}

/** Tailwind color class for the display status of a process. */
export function getStatusColor(p: StatusBearingProcess): string {
  const display = getDisplayStatus(p);
  if (!display) return processStatusConfig[ProcessStatus.NEW].color;
  return resolveConfig(display).color;
}

/** Icon component for the display status of a process. */
export function getStatusIcon(p: StatusBearingProcess): LucideIcon {
  const display = getDisplayStatus(p);
  if (!display) return processStatusConfig[ProcessStatus.NEW].icon;
  return resolveConfig(display).icon;
}

const sizeConfig = {
  sm: { icon: 'h-3 w-3', text: 'text-xs', gap: 'gap-1' },
  md: { icon: 'h-4 w-4', text: 'text-sm', gap: 'gap-1.5' },
  lg: { icon: 'h-5 w-5', text: 'text-base', gap: 'gap-2' },
};

export function StatusIndicator({ status, showLabel = false, size = 'md', className }: StatusIndicatorProps) {
  const config = processStatusConfig[status] ?? processStatusConfig[ProcessStatus.NEW];
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
  const config = processStatusConfig[status] ?? processStatusConfig[ProcessStatus.NEW];
  const Icon = config.icon;

  return (
    <div className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5', config.bgColor, className)}>
      <Icon className={cn('h-3.5 w-3.5', config.color, config.animate && 'animate-spin')} />
      <span className={cn('text-xs font-medium', config.color)}>{config.label}</span>
    </div>
  );
}

/**
 * Unified indicator that picks the right config based on ``getDisplayStatus``.
 * Accepts any ``StatusBearingProcess`` (class or plain object).
 */
interface ProcessStatusIndicatorProps {
  process: StatusBearingProcess;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function ProcessStatusIndicator({ process, showLabel = false, size = 'md', className }: ProcessStatusIndicatorProps) {
  const display = getDisplayStatus(process);
  const config = display ? resolveConfig(display) : processStatusConfig[ProcessStatus.NEW];
  const sizes = sizeConfig[size];
  const Icon = config.icon;

  return (
    <div className={cn('flex items-center', sizes.gap, className)}>
      <Icon className={cn(sizes.icon, config.color, config.animate && 'animate-spin')} />
      {showLabel && <span className={cn(sizes.text, config.color, 'font-medium')}>{config.label}</span>}
    </div>
  );
}
