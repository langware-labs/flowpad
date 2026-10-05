import { useState } from 'react';
import { t } from '@lingui/core/macro';
import { toast as sonnerToast, Toaster as Sonner } from 'sonner';
import { useTheme } from 'next-themes';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, X, type LucideIcon } from 'lucide-react';
import { EntityIcon } from '@src/components/graph-view/ui/EntityIcon';
import { lucideByName } from '@src/lib/lucide-by-name';
import { CopyButton } from '@src/components/ui/copy-button';
import { Checkbox } from '@src/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { notificationText, type NotificationData, type NotificationLevel } from './types';
import { runAction } from './commands';
import { settleAsk } from './pending-asks';
import { isAlertLevel, notify } from './notify';
import { useCenterStore } from './center-store';
import { DiagnoseIconButton } from './diagnose/DiagnoseIconButton';
import { NotificationProcessLine } from './NotificationProcessLine';

const LEVEL_ICON: Record<NotificationLevel, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

const LEVEL_TINT: Record<NotificationLevel, string> = {
  info: 'text-muted-foreground',
  success: 'text-green-500',
  warning: 'text-yellow-500',
  error: 'text-destructive',
};

/** `skill-<uuid>` → `skill`. iconForType wants the bare type. */
function typeOf(typeId: string): string {
  const dash = typeId.indexOf('-');
  return dash === -1 ? typeId : typeId.slice(0, dash);
}

export function NotificationGlyph({ data, size = 16 }: { data: NotificationData; size?: number }) {
  if (data.busy) return <Loader2 size={size} className="animate-spin text-muted-foreground" />;
  if (data.typeId) return <EntityIcon type={typeOf(data.typeId)} size={size} />;
  if (data.icon) {
    const Icon = lucideByName(data.icon);
    return <Icon size={size} className={LEVEL_TINT[data.level]} />;
  }
  const Icon = LEVEL_ICON[data.level];
  return <Icon size={size} className={LEVEL_TINT[data.level]} />;
}

const ACTION_BTN_BASE = 'rounded px-2 py-1 text-xs font-medium';
const ACTION_BTN_PRIMARY = `${ACTION_BTN_BASE} bg-primary text-primary-foreground hover:bg-primary/90`;
const ACTION_BTN_SECONDARY = `${ACTION_BTN_BASE} bg-muted text-muted-foreground hover:bg-muted/80`;

/**
 * The toast's buttons, and the "Don't ask again" box when the notification carries one. A
 * component (not inline in `renderToast`) because the box is state: its value rides the clicked
 * action's args as `remember`.
 */
function ToastActions({ data, close }: { data: NotificationData; close: () => void }) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {data.actions!.map((action, i) => (
          <button
            key={i}
            data-testid={`notification-action-${i}`}
            onClick={() => {
              runAction(action, data.id, data.remember ? { remember } : undefined);
              if (action.href) close();
            }}
            className={i === 0 ? ACTION_BTN_PRIMARY : ACTION_BTN_SECONDARY}
          >
            {action.label}
          </button>
        ))}
      </div>
      {data.remember && (
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            data-testid="notification-remember"
            aria-label={data.remember.label}
            checked={remember}
            onCheckedChange={(v) => setRemember(v === true)}
            className="h-3.5 w-3.5"
          />
          {data.remember.label}
        </label>
      )}
    </div>
  );
}

/**
 * The body of a single toast. Rendered by `notify()` via `sonner.toast.custom`,
 * so the same component handles entity icon, pre-line message, and serializable
 * actions. (The feed renders badges separately — see `feed/`.)
 */
export function renderToast(data: NotificationData, toastId: string) {
  return (
    <div className="flex w-full items-start gap-3 rounded-lg border border-border bg-background p-4 shadow-lg">
      <div className="mt-0.5 flex-shrink-0">
        <NotificationGlyph data={data} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{data.title}</div>
        {data.message && <div className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{data.message}</div>}
        <NotificationProcessLine data={data} />
        {data.actions && data.actions.length > 0 && (
          <ToastActions data={data} close={() => sonnerToast.dismiss(toastId)} />
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-0.5">
        {/* A failure is the one notification people need to paste into an issue
            or a chat, and it is also the one that disappears on a timer. The
            warnings popover has offered this for a while; the toast is where the
            text is actually in front of you. Alert levels only — nobody copies
            "Saved". */}
        {isAlertLevel(data.level) && (
          <CopyButton
            value={() => notificationText(data)}
            testId="notification-copy"
            title={t`Copy error text`}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            iconClassName="h-3.5 w-3.5"
          />
        )}
        <DiagnoseIconButton subject={data} />
        <button
          onClick={() => {
            settleAsk(data.id); // closing a question answers it with "no answer"
            sonnerToast.dismiss(toastId);
          }}
          aria-label={t`Dismiss notification`}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * A `location: 'center'` notification: a blocking dialog the person has to answer. No ×, and
 * neither Escape nor a click outside closes it — the only way out is one of its actions (or the
 * caller's own `notify.dismiss`). One at a time; the next in the queue follows.
 */
export function CenterNotification() {
  const data = useCenterStore((s) => s.queue[0] ?? null);
  const close = () => data && useCenterStore.getState().remove(data.id);
  return (
    <AlertDialog open={data !== null}>
      {data && (
        <AlertDialogContent
          data-testid="notification-center"
          className="max-w-md"
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex-shrink-0">
              <NotificationGlyph data={data} size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <AlertDialogTitle className="text-base">{data.title}</AlertDialogTitle>
              {data.message && (
                <AlertDialogDescription className="mt-1 whitespace-pre-line">{data.message}</AlertDialogDescription>
              )}
              <NotificationProcessLine data={data} />
              {data.actions && data.actions.length > 0 ? (
                <ToastActions data={data} close={close} />
              ) : (
                // Nothing to answer with: forcing an action would trap the person.
                <div className="mt-3">
                  <button onClick={() => notify.dismiss(data.id)} className={ACTION_BTN_PRIMARY}>
                    {t`OK`}
                  </button>
                </div>
              )}
            </div>
          </div>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}

/**
 * The single app-level notification renderer. Mount once (in App). Corner
 * notifications are sonner `toast.custom` (styling lives in `renderToast`);
 * centered ones are `CenterNotification`.
 */
export function NotificationOutlet() {
  const { theme = 'system' } = useTheme();
  return (
    <>
      <Sonner
        theme={theme as React.ComponentProps<typeof Sonner>['theme']}
        position="bottom-right"
        className="toaster group"
      />
      <CenterNotification />
    </>
  );
}
