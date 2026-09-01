import { UserWarning, WARNING_IDS, type WarningColor } from '@sdk';
import { openHarnessLoginModal } from '@src/components/harness-login/harness-login-store';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { openWikiModal } from '@src/components/wiki-tip';
import { useDockNavigation } from '@src/navigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useWarnings } from '@sdk/react/hooks';
import { runAction, runCommand, useAlertStore } from '@src/notifications';
import type { NotificationData, NotificationLevel } from '@src/notifications';
import { DiagnoseIconButton } from '@src/notifications/diagnose/DiagnoseIconButton';
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
const colorMap: Record<WarningColor, { bg: string; text: string; border: string }> = {
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

/** Alert level → the same colour vocabulary the derived warnings use. */
const ALERT_COLOR: Record<NotificationLevel, keyof typeof colorMap> = {
  error: 'red',
  warning: 'yellow',
  info: 'blue',
  success: 'gray',
};

const ITEM_CLASS = 'group flex w-full items-start gap-2 rounded-md border p-3 transition-colors hover:bg-accent';
const ICON_BTN_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100';
/** Same 24px box as ICON_BTN_CLASS, minus the hover-reveal: the stethoscope is
 *  an offer, so it stays visible. Sharing the box keeps it on the same icon
 *  grid as Copy and Dismiss instead of floating a few pixels off. */
const DIAGNOSE_BTN_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/** Copy-to-clipboard affordance, shared by derived warnings and logged alerts. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard write can reject under restrictive permissions; fail silently
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
      className={ICON_BTN_CLASS}
      title={copied ? 'Copied!' : 'Copy warning text'}
      aria-label={copied ? 'Copied' : 'Copy warning text'}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

interface WarningItemProps {
  warning: UserWarning;
  onClick: () => void;
}

/**
 * A derived warning — it describes a condition that is true right now
 * (cloud down, no harness, sniffer on). Deliberately NOT dismissible: it goes
 * away when the condition does. Only the logged alerts below can be dismissed.
 */
function WarningItem({ warning, onClick }: WarningItemProps) {
  const Icon = iconMap[warning.icon] || AlertTriangle;
  const colors = colorMap[warning.color] || colorMap.yellow;

  return (
    <div className={`${ITEM_CLASS} ${colors.border}`} data-testid="warnings-popover-warning">
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-start gap-3 text-start">
        <div className={`rounded-md p-1.5 ${colors.bg}`}>
          <Icon className={`h-4 w-4 ${colors.text}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{warning.message}</p>
          {warning.description && <p className="mt-0.5 text-xs text-muted-foreground">{warning.description}</p>}
        </div>
      </button>
      <div className="flex shrink-0 items-start gap-0.5">
        <CopyButton text={warning.description ? `${warning.message}\n${warning.description}` : warning.message} />
        {/* Everything in this popover is a warning by construction, so a derived
            condition (cloud down, no harness) is diagnosable just like a logged one. */}
        <DiagnoseIconButton
          subject={{ level: 'warning', title: warning.message, message: warning.description }}
          className={DIAGNOSE_BTN_CLASS}
        />
        {/* A derived warning is never dismissible, but its neighbours are: hold
            the empty dismiss slot so the stethoscope lands in the same top-right
            column on every row, warning and error alike. */}
        <span className="h-6 w-6 shrink-0" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * A logged alert — a `warning`/`error` notification that outside Dev mode never
 * popped as a toast (see `notify.ts`). It reports something that already
 * happened, so unlike a derived warning it IS dismissible; its CTAs are carried
 * over so the user can still act on it from here.
 */
function AlertItem({ alert, onDismiss }: { alert: NotificationData; onDismiss: () => void }) {
  const colors = colorMap[ALERT_COLOR[alert.level]] || colorMap.yellow;
  const Icon = alert.level === 'error' ? AlertCircle : AlertTriangle;

  return (
    <div className={`${ITEM_CLASS} ${colors.border}`} data-testid="warnings-popover-alert">
      <div className={`rounded-md p-1.5 ${colors.bg}`}>
        <Icon className={`h-4 w-4 ${colors.text}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{alert.title}</p>
        {alert.message && <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{alert.message}</p>}
        {alert.actions && alert.actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {alert.actions.map((action, i) => (
              <button
                key={i}
                type="button"
                onClick={() => runAction(action, alert.id)}
                className={`rounded px-2 py-1 text-xs font-medium ${
                  i === 0
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        <CopyButton text={alert.message ? `${alert.title}\n${alert.message}` : alert.title} />
        <DiagnoseIconButton subject={alert} className={DIAGNOSE_BTN_CLASS} />
        <button
          type="button"
          onClick={onDismiss}
          className={ICON_BTN_CLASS}
          title="Dismiss"
          aria-label={`Dismiss ${alert.title}`}
          data-testid="warnings-popover-dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function WarningsPopover() {
  const { warnings } = useWarnings();
  const alerts = useAlertStore((s) => s.alerts);
  const dismissAlert = useAlertStore((s) => s.dismiss);
  const dismissAllAlerts = useAlertStore((s) => s.dismissAll);
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    setOpen(isOpen);
  }, []);

  const handleWarningClick = useCallback(
    (warning: UserWarning) => {
      if (warning.id === WARNING_IDS.SNIFFER_ACTIVE) {
        // Same command the startup toast's Disable button runs — one path,
        // one set of success/failure toasts.
        runCommand('sniffer.disable', {}, { id: warning.id });
      } else if (warning.id === WARNING_IDS.NO_HARNESS || warning.id === WARNING_IDS.HARNESS_LOGIN) {
        // Both harness warnings open the login modal — it shows install links
        // for missing CLIs and the device-login flow for logged-out ones.
        openHarnessLoginModal();
      } else if (warning.onClick) {
        warning.onClick();
      } else if (warning.wikiPage) {
        openWikiModal(warning.wikiPage);
      } else {
        // `openTab` carries no pointer, so a warning that names a subview
        // (Credentials → Connections) has to go through openDock.
        if (warning.targetPointer) {
          navigation.openDock(new DockPointer(warning.targetView, warning.targetPointer));
        } else {
          navigation.openTab(warning.targetView);
        }
      }
      setOpen(false);
    },
    [navigation],
  );

  const total = warnings.length + alerts.length;

  // Nothing to say — neither a live condition nor a logged alert.
  if (total === 0) {
    return null;
  }

  // Trigger tint follows the most severe item, alerts included: an error that
  // never got to be a toast still has to look like an error in the footer.
  const severity: Record<WarningColor, number> = { red: 3, orange: 2, yellow: 1, blue: 0, gray: 0 };
  const colorKeys: Array<keyof typeof colorMap> = [
    ...warnings.map((w) => w.color),
    ...alerts.map((a) => ALERT_COLOR[a.level]),
  ];
  const worstColor = colorKeys.reduce((prev, curr) => ((severity[curr] || 0) > (severity[prev] || 0) ? curr : prev));
  const triggerColors = colorMap[worstColor] || colorMap.yellow;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={`relative flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-accent ${triggerColors.text}`}
          data-testid="warnings-popover-trigger"
        >
          <AlertTriangle className="h-4 w-4" />
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
            {total}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex max-h-[70vh] w-96 flex-col p-2">
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          <p className="text-xs font-medium text-muted-foreground">
            {total} {total === 1 ? 'Warning' : 'Warnings'}
          </p>
          {/* Only the logged alerts are dismissible, so the bulk action is
              offered only when there is at least one. */}
          {alerts.length > 0 && (
            <button
              type="button"
              onClick={dismissAllAlerts}
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="warnings-popover-dismiss-all"
            >
              Dismiss all
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {warnings.map((warning) => (
            <WarningItem key={warning.id} warning={warning} onClick={() => handleWarningClick(warning)} />
          ))}
          {alerts.map((alert) => (
            <AlertItem key={alert.id} alert={alert} onDismiss={() => dismissAlert(alert.id)} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
