import { t } from '@lingui/core/macro';
import { toast as sonnerToast, Toaster as Sonner } from 'sonner';
import { useTheme } from 'next-themes';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, X, type LucideIcon } from 'lucide-react';
import { EntityIcon } from '@src/components/graph-view/ui/EntityIcon';
import { lucideByName } from '@src/lib/lucide-by-name';
import { CopyButton } from '@src/components/ui/copy-button';
import { notificationText, type NotificationData, type NotificationLevel } from './types';
import { runAction } from './commands';
import { isAlertLevel } from './notify';
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
          <div className="mt-2 flex flex-wrap gap-2">
            {data.actions.map((action, i) => (
              <button
                key={i}
                onClick={() => {
                  runAction(action, data.id);
                  if (action.href) sonnerToast.dismiss(toastId);
                }}
                className={i === 0 ? ACTION_BTN_PRIMARY : ACTION_BTN_SECONDARY}
              >
                {action.label}
              </button>
            ))}
          </div>
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
          onClick={() => sonnerToast.dismiss(toastId)}
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
 * The single app-level toast renderer. Mount once (in App). Backed by sonner;
 * our toasts are `toast.custom`, so styling lives in `renderToast`.
 */
export function NotificationOutlet() {
  const { theme = 'system' } = useTheme();
  return (
    <Sonner
      theme={theme as React.ComponentProps<typeof Sonner>['theme']}
      position="bottom-right"
      className="toaster group"
    />
  );
}
