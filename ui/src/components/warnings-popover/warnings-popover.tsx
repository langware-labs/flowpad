import { UserWarning } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useDockNavigation } from '@src/navigation';
import { useWarnings } from '@sdk/react/hooks';
import {
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  Check,
  CloudOff,
  Copy,
  Info,
  Key,
  Settings,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useState } from 'react';

// Map icon names to Lucide components
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  AlertTriangle,
  AlertCircle,
  AlertOctagon,
  Info,
  X,
  CloudOff,
  Wifi,
  WifiOff,
  Settings,
  Key,
};

// Map color names to Tailwind classes
const colorMap: Record<string, { bg: string; text: string; border: string }> = {
  yellow: {
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-500',
    border: 'border-yellow-500/20',
  },
  red: {
    bg: 'bg-red-500/10',
    text: 'text-red-500',
    border: 'border-red-500/20',
  },
  orange: {
    bg: 'bg-orange-500/10',
    text: 'text-orange-500',
    border: 'border-orange-500/20',
  },
  blue: {
    bg: 'bg-blue-500/10',
    text: 'text-blue-500',
    border: 'border-blue-500/20',
  },
  gray: {
    bg: 'bg-gray-500/10',
    text: 'text-gray-400',
    border: 'border-gray-500/20',
  },
};

interface WarningItemProps {
  warning: UserWarning;
  onClick: () => void;
}

function WarningItem({ warning, onClick }: WarningItemProps) {
  const Icon = iconMap[warning.icon] || AlertTriangle;
  const colors = colorMap[warning.color] || colorMap.yellow;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      const text = warning.description
        ? `${warning.message}\n${warning.description}`
        : warning.message;
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        // clipboard write can reject under restrictive permissions; fail silently
      }
    },
    [warning.message, warning.description],
  );

  return (
    <div
      className={`group flex w-full items-start gap-2 rounded-md border p-3 transition-colors hover:bg-accent ${colors.border}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        <div className={`rounded-md p-1.5 ${colors.bg}`}>
          <Icon className={`h-4 w-4 ${colors.text}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{warning.message}</p>
          {warning.description && <p className="mt-0.5 text-xs text-muted-foreground">{warning.description}</p>}
        </div>
      </button>
      <button
        type="button"
        onClick={handleCopy}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
        title={copied ? 'Copied!' : 'Copy warning text'}
        aria-label={copied ? 'Copied' : 'Copy warning text'}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function WarningsPopover() {
  const { warnings } = useWarnings();
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    setOpen(isOpen);
  }, []);

  const handleWarningClick = useCallback(
    (warning: UserWarning) => {
      if (warning.onClick) {
        warning.onClick();
      } else {
        navigation.openTab(warning.targetView);
      }
      setOpen(false);
    },
    [navigation],
  );

  // Don't render if no warnings
  if (warnings.length === 0) {
    return null;
  }

  // Get the most severe warning color for the trigger icon
  const mostSevereWarning = warnings.reduce((prev, curr) => {
    const severity = { red: 3, orange: 2, yellow: 1, blue: 0, gray: 0 };
    return (severity[curr.color] || 0) > (severity[prev.color] || 0) ? curr : prev;
  }, warnings[0]);

  const triggerColors = colorMap[mostSevereWarning.color] || colorMap.yellow;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={`relative flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-accent ${triggerColors.text}`}
          data-testid="warnings-popover-trigger"
        >
          <AlertTriangle className="h-4 w-4" />
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
            {warnings.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-2">
        <div className="space-y-2">
          <p className="px-1 text-xs font-medium text-muted-foreground">
            {warnings.length} {warnings.length === 1 ? 'Warning' : 'Warnings'}
          </p>
          {warnings.map((warning) => (
            <WarningItem key={warning.id} warning={warning} onClick={() => handleWarningClick(warning)} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
