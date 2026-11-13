import { Trans, useLingui } from '@lingui/react/macro';
import { UserWarning, WARNING_IDS, type WarningColor } from '@sdk';
import { useHelpRequestDiagnosis } from '@src/components/conversation/use-help-request-diagnosis';
import { openHarnessLoginModal } from '@src/components/harness-login/harness-login-store';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { openWikiModal } from '@src/components/wiki-tip';
import { useDockNavigation } from '@src/navigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useWarnings } from '@sdk/react/hooks';
import { useSetupIncompleteWarning } from '@src/components/setup-incomplete/use-setup-incomplete-warning';
import {
  diagnoseAndFix,
  notificationText,
  runAction,
  runCommand,
  useAlertStore,
  useDiagnosisLinks,
} from '@src/notifications';
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
  Loader2,
  Settings,
  Wifi,
  WifiOff,
  X,
  ArrowUpCircle,
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
  ArrowUpCircle,
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
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 pointer-coarse:opacity-100';

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

/** The diagnosis started from an entry, as one line — the same conversation, seen from the warning. It reads the
 *  conversation's own state (``help-request-diagnosis``); while the diagnosis runs it looks again now and then,
 *  like the request line in the conversation does. */
function DiagnosisStatusLine({ conversationId }: { conversationId: string }) {
  const { t } = useLingui();
  const [state] = useHelpRequestDiagnosis(conversationId);

  const d = state?.diagnosis;
  let status: 'diagnosing' | 'replied' | 'reported' | 'fixed' | 'report' | 'diagnosed' | 'failed';
  let text: string;
  if (!state || state.diagnosing) {
    status = 'diagnosing';
    text = t`Diagnosing… you'll get a message when it's done`;
  } else if (state.reported && state.replied) {
    status = 'replied';
    text = t`Help desk replied`;
  } else if (state.reported) {
    status = 'reported';
    text = t`Sent to the help desk`;
  } else if (!d) {
    status = 'failed';
    text = t`The diagnosis could not run — you can report it from the conversation`;
  } else if (d.status === 'fixed') {
    status = 'fixed';
    text = t`Fixed: ${d.fix || d.summary}`;
  } else if (state.reportable) {
    status = 'report';
    text = t`Couldn't fix it here — report it from the conversation`;
  } else {
    status = 'diagnosed';
    text = t`Diagnosed: ${d.summary}`;
  }
  return (
    <p
      className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs text-foreground/90"
      data-testid="warnings-popover-diagnosis-status"
      data-status={status}
    >
      {status === 'diagnosing' ? (
        <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" aria-hidden />
      ) : status === 'failed' || status === 'report' ? (
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" aria-hidden />
      ) : (
        <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-500" aria-hidden />
      )}
      <span className="min-w-0">{text}</span>
    </p>
  );
}

const PRIMARY_BTN = 'rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90';
const MUTED_BTN = 'rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80';

/** Informational: nothing is broken, so a diagnosis has nothing to find — listed, not counted. */
const isInformational = (warning: UserWarning) => warning.diagnosable === false;

/** An entry's Diagnose & fix: enabled until a diagnosis was started from it; then disabled, with the way to its
 *  conversation beside it. An informational entry gets Review (its own destination) in its place. Dismiss stays
 *  on every entry, always — it is the only way an entry leaves. */
function DiagnoseButtons({
  conversationId,
  onDiagnose,
  onReview,
  onDismiss,
  testId,
}: {
  conversationId: string | undefined;
  onDiagnose: () => void;
  onReview?: () => void;
  onDismiss: () => void;
  testId: string;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  return (
    <>
      {onReview ? (
        <button type="button" onClick={onReview} className={PRIMARY_BTN} data-testid="warnings-popover-warning-review">
          <Trans>Review</Trans>
        </button>
      ) : (
        <button
          type="button"
          onClick={onDiagnose}
          disabled={!!conversationId}
          title={conversationId ? t`Already diagnosed — see the conversation` : undefined}
          className={`${PRIMARY_BTN} disabled:cursor-not-allowed disabled:opacity-50`}
          data-testid={testId}
        >
          <Trans>Diagnose &amp; fix</Trans>
        </button>
      )}
      {conversationId && (
        <button
          type="button"
          onClick={() => navigation.openDock(DockPointer.forConversation(conversationId))}
          className={MUTED_BTN}
          data-testid="warnings-popover-open-conversation"
        >
          <Trans>Open conversation</Trans>
        </button>
      )}
      <button type="button" onClick={onDismiss} className={MUTED_BTN} data-testid="warnings-popover-dismiss-button">
        <Trans>Dismiss</Trans>
      </button>
    </>
  );
}

interface WarningItemProps {
  warning: UserWarning;
  onClick: () => void;
  /** The warning's own button (`warning.action`), already wired to close the popover. */
  onAction: () => void;
  /** Diagnose & fix — starts it in place; the entry then shows its status. */
  onDiagnose: (detail: string, kind: DiagnoseKind, entryKey: string) => void;
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
  const conversationId = useDiagnosisLinks((s) => s.links[warning.id]);

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
              className={PRIMARY_BTN}
              data-testid="warnings-popover-warning-action"
            >
              {warning.action.label}
            </button>
          )}
          {/* Everything in this popover is a warning by construction, so a derived
              condition (cloud down, no harness) is diagnosable just like a logged one. */}
          <DiagnoseButtons
            conversationId={conversationId}
            onDiagnose={() => onDiagnose(detail, 'warning', warning.id)}
            onReview={isInformational(warning) ? onClick : undefined}
            onDismiss={onDismiss}
            testId="warnings-popover-warning-diagnose-fix"
          />
        </div>
        {conversationId && (
          <div className="ms-10">
            <DiagnosisStatusLine conversationId={conversationId} />
          </div>
        )}
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
  const text = alert.message;
  const conversationId = useDiagnosisLinks((s) => s.links[alert.id]);

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
        {conversationId && <DiagnosisStatusLine conversationId={conversationId} />}
        <div className="mt-2 flex flex-wrap gap-2">
          {(alert.actions ?? []).map((action, i) => (
            <button
              key={i}
              type="button"
              onClick={() => runAction(action, alert.id)}
              className={i === 0 ? PRIMARY_BTN : MUTED_BTN}
            >
              {action.label}
            </button>
          ))}
          <ErrorDetailsButton data={alert} />
          {/* The log holds only warnings and errors, both diagnosable. */}
          <DiagnoseButtons
            conversationId={conversationId}
            onDiagnose={() => onDiagnose(notificationText(alert), alert.level as DiagnoseKind, alert.id)}
            onDismiss={onDismiss}
            testId="warnings-popover-diagnose-fix"
          />
        </div>
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
  const [open, setOpen] = useState(false);
  // Starts in place: no navigation, the popover stays open and the entry shows the diagnosis status.
  const diagnose = useCallback((detail: string, kind: DiagnoseKind, entryKey: string) => {
    void diagnoseAndFix(detail, kind, entryKey);
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
  const problemCount = warnings.filter((w) => !isInformational(w)).length + alerts.length;

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
          {problemCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
              {problemCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex max-h-[70vh] w-96 flex-col p-2">
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          <p className="text-xs font-medium text-muted-foreground">
            {problemCount} {problemCount === 1 ? 'Warning' : 'Warnings'}
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
