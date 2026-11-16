import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, CircleAlert, Loader2, Monitor } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Issue, type IssueManualStatus, type IssueReplyMeta, type IssueStatus } from '@sdk';
import { isIssueActive } from '@sdk/entities/issue';
import { fixPointer, resolveFixPointer } from '@src/components/asset-counters/issue-counters';
import { Button } from '@src/components/ui/button';
import { entityDock } from '@src/lib/hub-page-url';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { humanizeSeconds } from '@src/utils/duration';

const STATUS_TONE: Record<IssueStatus, string> = {
  open: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  seen: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  in_progress: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  resolved: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  closed: 'border-border/60 bg-muted text-muted-foreground',
};

function statusLabel(status: IssueStatus): string {
  switch (status) {
    case 'seen':
      return t`Seen`;
    case 'in_progress':
      return t`In progress`;
    case 'resolved':
      return t`Resolved`;
    case 'closed':
      return t`Closed`;
    default:
      return t`Open`;
  }
}

/** The issue's id from its typeid (`issue-<id>`), or '' when it names something else. */
function issueIdOf(typeid: string): string {
  const prefix = `${Issue.type}-`;
  return typeid.startsWith(prefix) ? typeid.slice(prefix.length) : '';
}

/** How long an issue was open ("50s", "3m 20s"), or '' when a time is missing; both are epoch seconds. */
export function issueDuration(from: number | null | undefined, to: number | null | undefined): string {
  return from && to && to >= from ? humanizeSeconds(to - from) : '';
}

/** How the issue stands now, in words: "Resolved by itself after 50s", "Open for 3m", "Closed". */
export function issueStandingText(reply: Pick<IssueReplyMeta, 'status' | 'opened_at' | 'resolved_at'>): string {
  const took = issueDuration(reply.opened_at, reply.resolved_at);
  if (reply.status === 'resolved') return took ? t`Resolved by itself after ${took}` : t`Resolved by itself`;
  if (reply.status === 'closed') return took ? t`Closed after ${took}` : t`Closed`;
  const open = issueDuration(reply.opened_at, Date.now() / 1000);
  return open ? t`${statusLabel(reply.status)} for ${open}` : statusLabel(reply.status);
}

const STATUS_ACCENT: Record<IssueStatus, string> = {
  open: 'before:bg-red-500',
  seen: 'before:bg-amber-500',
  in_progress: 'before:bg-sky-500',
  resolved: 'before:bg-emerald-500',
  closed: 'before:bg-muted-foreground/40',
};

/**
 * An issue's message in a Monitoring conversation, as one card: a header (severity, title, ×count, status) that
 * opens the issue's page, chips for the machine (opens what the fix names) and the cause, and a footer with how
 * it stands, the fix and the manual moves (work on it, close it, reopen it). The hub updates the message itself,
 * so the status follows `reply.status`; a click shows the new status at once.
 */
export function IssueReplyLine({ reply }: { reply: IssueReplyMeta }) {
  const { navigation } = useDockNavigation();
  const [status, setStatus] = useState<IssueStatus>(reply.status);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setStatus(reply.status), [reply.status]);

  const pointer = fixPointer(reply);
  const issueId = issueIdOf(reply.issue_typeid);
  const active = isIssueActive(status);

  const move = async (next: IssueManualStatus) => {
    setBusy(true);
    setFailed(false);
    try {
      await Issue.setStatus(issueId, next);
      setStatus(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const SeverityIcon = reply.severity === 'warning' ? AlertTriangle : CircleAlert;
  const openIssue = () => {
    if (issueId) navigation.openDockOnThisPage(entityDock(Issue.type, issueId));
  };
  const openMachine = () =>
    void resolveFixPointer(reply).then((target) => {
      const to = target ?? pointer;
      if (to) navigation.openDockOnThisPage(to);
    });
  const actionClass = 'h-7 rounded-md px-2.5 text-xs';
  const MOVE_TEST_ID: Record<IssueManualStatus, string> = {
    in_progress: 'issue-reply-in-progress',
    closed: 'issue-reply-close',
    open: 'issue-reply-reopen',
  };
  const moveButton = (to: IssueManualStatus, label: ReactNode) => (
    <Button
      variant="ghost"
      size="sm"
      className={actionClass}
      disabled={busy}
      onClick={() => void move(to)}
      data-testid={MOVE_TEST_ID[to]}
    >
      {label}
    </Button>
  );
  return (
    <div
      className={cn(
        'relative mt-1 max-w-xl overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm transition-opacity',
        'before:absolute before:inset-y-0 before:start-0 before:w-1',
        STATUS_ACCENT[status],
        !active && 'opacity-80 hover:opacity-100',
      )}
      data-testid="issue-card"
    >
      <button
        type="button"
        onClick={openIssue}
        className="group flex w-full items-start gap-3 px-4 pb-2 pt-3 text-start transition-colors hover:bg-accent/30"
        data-testid="issue-card-row-what"
      >
        <SeverityIcon
          className={cn('mt-0.5 h-4 w-4 shrink-0', reply.severity === 'warning' ? 'text-amber-500' : 'text-red-500')}
          aria-label={reply.severity === 'warning' ? t`Warning` : t`Error`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground" data-testid="issue-reply-title">
              {reply.title}
            </span>
            {reply.count > 1 && (
              <span
                className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground"
                data-testid="issue-reply-count"
                title={t`Happened ${reply.count} times`}
              >
                ×{reply.count}
              </span>
            )}
          </div>
          {reply.detail && reply.detail !== reply.title && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{reply.detail}</p>
          )}
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            STATUS_TONE[status],
          )}
          data-testid="issue-reply-status"
          data-issue-status={status}
        >
          {statusLabel(status)}
        </span>
      </button>

      {(reply.machine || reply.cause) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 ps-11">
          {reply.machine && (
            <button
              type="button"
              onClick={openMachine}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent"
              data-testid="issue-card-row-machine"
            >
              <Monitor className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{reply.machine}</span>
            </button>
          )}
          {reply.cause && (
            <span
              className="min-w-0 max-w-full truncate rounded-md bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              title={reply.cause}
              data-testid="issue-card-row-cause"
            >
              {reply.cause}
            </span>
          )}
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-1.5 border-t border-border/40 bg-muted/20 px-4 py-1.5 ps-11 text-xs"
        data-testid="issue-reply-line"
      >
        <span className="me-auto text-muted-foreground" data-testid="issue-card-row-status">
          {issueStandingText({ ...reply, status })}
        </span>
        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        {failed && (
          <span className="text-red-600 dark:text-red-400">
            <Trans>Could not update the issue.</Trans>
          </span>
        )}
        {active && reply.fix && pointer && (
          <Button
            size="sm"
            className={actionClass}
            onClick={openMachine}
            data-testid="issue-reply-fix"
          >
            {reply.fix.label}
          </Button>
        )}
        {issueId && active && status !== 'in_progress' && moveButton('in_progress', <Trans>Mark in progress</Trans>)}
        {issueId && active && moveButton('closed', <Trans>Close</Trans>)}
        {issueId && status === 'closed' && moveButton('open', <Trans>Reopen</Trans>)}
      </div>
    </div>
  );
}
