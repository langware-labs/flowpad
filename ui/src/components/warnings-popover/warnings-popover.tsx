import { Trans, useLingui } from '@lingui/react/macro';
import { UserWarning, WARNING_IDS, type WarningColor } from '@sdk';
import { openHarnessLoginModal } from '@src/components/harness-login/harness-login-store';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { openWikiModal } from '@src/components/wiki-tip';
import { useDockNavigation } from '@src/navigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useContext, useWarnings } from '@sdk/react/hooks';
import { useSetupIncompleteWarning } from '@src/components/setup-incomplete/use-setup-incomplete-warning';
import { openProjectSetup } from '@src/components/project-setup/project-setup-store';
import { diagnoseAndFix, notificationText, runAction, runCommand, useAlertStore } from '@src/notifications';
import type { NotificationData, NotificationLevel } from '@src/notifications';
import type { DiagnoseKind } from '@src/notifications/diagnose/diagnose-and-fix';
import { ErrorDetailsButton } from '@src/notifications/ErrorDetailsDialog';
import {
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  Check,
  CloudOff,
  Copy,
  FolderX,
  Info,
  Key,
  Settings,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { create } from 'zustand';

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
  FolderX,
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

/** Copy-to-clipboard affordance, shared by derived warnings and logged alerts. */
function CopyButton({ text }: { text: string }) {
  const { t } = useLingui();
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
      title={copied ? t`Copied!` : t`Copy warning text`}
      aria-label={copied ? t`Copied` : t`Copy warning text`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** A dismissed warning is hidden until it says something else — another project, another count —
 *  so the key is its text, not only its id. */
const dismissKey = (w: UserWarning) => `${w.id}\n${w.message}\n${w.description ?? ''}`;

/** Warnings dismissed this app session, as id → the text dismissed (new text replaces it, so it
 *  stays one entry per warning). Module-level: every layout mounts its own footer, and a dismissal
 *  must survive switching between them. */
const useDismissedWarnings = create<{ keys: ReadonlyMap<string, string>; dismiss: (warnings: UserWarning[]) => void }>(
  (set) => ({
    keys: new Map(),
    dismiss: (warnings) =>
      set((s) => ({ keys: new Map([...s.keys, ...warnings.map((w) => [w.id, dismissKey(w)] as const)]) })),
  }),
);

interface WarningItemProps {
  warning: UserWarning;
  onClick: () => void;
  /** The warning's own button (`warning.action`), already wired to close the popover. */
  onAction: () => void;
  /** Diagnose & fix — closes the popover: the conversation it opens is what comes next. */
  onDiagnose: (detail: string, kind: DiagnoseKind, alertId?: string) => void;
  onDismiss: () => void;
}

/**
 * A derived warning — it describes a condition that is true right now
 * (cloud down, no harness, sniffer on), and goes away when the condition does.
 * Dismissing it hides it for this session, until it says something else.
 */
function WarningItem({ warning, onClick, onAction, onDiagnose, onDismiss }: WarningItemProps) {
  const { t } = useLingui();
  // Named like AlertItem's placeholder, so both rows share one translated "Dismiss …".
  const alertTitle = warning.message;
  const Icon = iconMap[warning.icon] || AlertTriangle;
  const colors = colorMap[warning.color] || colorMap.yellow;
  const detail = warning.description ? `${warning.message}\n${warning.description}` : warning.message;

  return (
    <div className={`${ITEM_CLASS} ${colors.border}`} data-testid="warnings-popover-warning">
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onClick} className="flex w-full items-start gap-3 text-start">
          <div className={`rounded-md p-1.5 ${colors.bg}`}>
            <Icon className={`h-4 w-4 ${colors.text}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{warning.message}</p>
            {warning.description && <p className="mt-0.5 text-xs text-muted-foreground">{warning.description}</p>}
          </div>
        </button>
        {/* Beside the row's own click target, not inside it: a button never nests in a button. The
            start margin is the icon's width plus the gap, so it lines up under the text. */}
        <div className="ms-10 mt-2 flex flex-wrap gap-2">
          {warning.action && (
            <button
              type="button"
              onClick={onAction}
              className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="warnings-popover-warning-action"
            >
              {warning.action.label}
            </button>
          )}
          {/* Everything in this popover is a warning by construction, so a derived
              condition (cloud down, no harness) is diagnosable just like a logged one. */}
          <button
            type="button"
            onClick={() => onDiagnose(detail, 'warning')}
            className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="warnings-popover-warning-diagnose-fix"
          >
            <Trans>Diagnose &amp; fix</Trans>
          </button>
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        <CopyButton text={detail} />
        <button
          type="button"
          onClick={onDismiss}
          className={ICON_BTN_CLASS}
          title={t`Dismiss`}
          aria-label={t`Dismiss ${alertTitle}`}
          data-testid="warnings-popover-warning-dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
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
function AlertItem({
  alert,
  onDiagnose,
  onDismiss,
}: {
  alert: NotificationData;
  onDiagnose: WarningItemProps['onDiagnose'];
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const alertTitle = alert.title;
  const colors = colorMap[ALERT_COLOR[alert.level]] || colorMap.yellow;
  const Icon = alert.level === 'error' ? AlertCircle : AlertTriangle;
  const text = alert.fixed?.summary ?? alert.message;

  return (
    <div className={`${ITEM_CLASS} ${colors.border}`} data-testid="warnings-popover-alert">
      <div className={`relative rounded-md p-1.5 ${colors.bg}`}>
        <Icon className={`h-4 w-4 ${colors.text}`} />
        {(alert.count ?? 1) > 1 && (
          <span
            className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white"
            data-testid="warnings-popover-alert-count"
          >
            {alert.count}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{alert.title}</p>
        {text && <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{text}</p>}
        {alert.fixed ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-400"
              data-testid="warnings-popover-fixed"
            >
              ✓ <Trans>Fixed</Trans>
            </span>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700"
              data-testid="warnings-popover-done"
            >
              <Trans>Done — remove</Trans>
            </button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {(alert.actions ?? []).map((action, i) => (
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
            <ErrorDetailsButton data={alert} />
            {/* The log holds only warnings and errors, both diagnosable. */}
            <button
              type="button"
              onClick={() => onDiagnose(notificationText(alert), alert.level as DiagnoseKind, alert.id)}
              className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="warnings-popover-diagnose-fix"
            >
              <Trans>Diagnose &amp; fix</Trans>
            </button>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        <CopyButton text={notificationText(alert)} />
        <button
          type="button"
          onClick={onDismiss}
          className={ICON_BTN_CLASS}
          title={t`Dismiss`}
          aria-label={t`Dismiss ${alertTitle}`}
          data-testid="warnings-popover-dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function WarningsPopover() {
  const { warnings: derivedWarnings } = useWarnings();
  const setupWarning = useSetupIncompleteWarning();
  const dismissedKeys = useDismissedWarnings((s) => s.keys);
  const dismissWarnings = useDismissedWarnings((s) => s.dismiss);
  const warnings = useMemo(
    () =>
      [...derivedWarnings, ...(setupWarning ? [setupWarning] : [])].filter(
        (w) => dismissedKeys.get(w.id) !== dismissKey(w),
      ),
    [derivedWarnings, setupWarning, dismissedKeys],
  );
  const alerts = useAlertStore((s) => s.alerts);
  const dismissAlert = useAlertStore((s) => s.dismiss);
  const dismissAllAlerts = useAlertStore((s) => s.dismissAll);
  const dismissAll = useCallback(() => {
    dismissWarnings(warnings);
    dismissAllAlerts();
  }, [dismissWarnings, warnings, dismissAllAlerts]);
  const { navigation } = useDockNavigation();
  const { project } = useContext();
  const [open, setOpen] = useState(false);
  const diagnose = useCallback((detail: string, kind: DiagnoseKind, alertId?: string) => {
    setOpen(false);
    void diagnoseAndFix(detail, kind, alertId);
  }, []);

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
      } else if (warning.id === WARNING_IDS.PROJECT_SETUP_REQUIRED && project) {
        openProjectSetup({ projectId: String(project.id), projectName: project.name ?? '' });
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
    [navigation, project],
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
          <button
            type="button"
            onClick={dismissAll}
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            data-testid="warnings-popover-dismiss-all"
          >
            <Trans>Dismiss all</Trans>
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {warnings.map((warning) => (
            <WarningItem
              key={warning.id}
              warning={warning}
              onClick={() => handleWarningClick(warning)}
              onAction={() => {
                warning.action?.onClick();
                setOpen(false);
              }}
              onDiagnose={diagnose}
              onDismiss={() => dismissWarnings([warning])}
            />
          ))}
          {alerts.map((alert) => (
            <AlertItem key={alert.id} alert={alert} onDiagnose={diagnose} onDismiss={() => dismissAlert(alert.id)} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
