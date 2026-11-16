import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, ChevronRight, CircleAlert, Loader2 } from 'lucide-react';
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

function CardRow({
  name,
  label,
  onOpen,
  children,
}: {
  name: string;
  label: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 border-b border-border/40 px-3 py-1.5 text-start text-sm transition-colors last:border-b-0 hover:bg-accent/40"
      onClick={onOpen}
      data-testid={`issue-card-row-${name}`}
    >
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{children}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden="true" />
    </button>
  );
}

/**
 * An issue's message in a Monitoring conversation: a card of what happened (each row opens the issue's own
 * page, the machine row what the fix names), then severity, title, status, how many times it happened, the fix,
 * and the manual moves (work on it, close it, reopen it). The hub updates the message itself, so the status
 * here follows `reply.status`; a click shows the new status at once. (The bubble does not mount this for the
 * "Resolved: …" follow-up the hub posts afterwards: that is a line of text alone.)
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
  const line = (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" data-testid="issue-reply-line">
      <SeverityIcon
        className={cn('h-3.5 w-3.5 shrink-0', reply.severity === 'warning' ? 'text-amber-500' : 'text-red-500')}
        aria-label={reply.severity === 'warning' ? t`Warning` : t`Error`}
      />
      <span className="font-medium text-foreground" data-testid="issue-reply-title">
        {reply.title}
      </span>
      <span
        className={cn('inline-flex items-center rounded-full border px-2 py-0.5', STATUS_TONE[status])}
        data-testid="issue-reply-status"
        data-issue-status={status}
      >
        {statusLabel(status)}
      </span>
      {reply.count > 1 && (
        <span className="text-muted-foreground" data-testid="issue-reply-count">
          ×{reply.count}
        </span>
      )}
      {active && reply.fix && pointer && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() =>
            void resolveFixPointer(reply).then((target) => navigation.openDockOnThisPage(target ?? pointer))
          }
          data-testid="issue-reply-fix"
        >
          {reply.fix.label}
        </Button>
      )}
      {issueId && active && status !== 'in_progress' && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => void move('in_progress')}
          data-testid="issue-reply-in-progress"
        >
          <Trans>Mark in progress</Trans>
        </Button>
      )}
      {issueId && active && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => void move('closed')}
          data-testid="issue-reply-close"
        >
          <Trans>Close</Trans>
        </Button>
      )}
      {issueId && status === 'closed' && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => void move('open')}
          data-testid="issue-reply-reopen"
        >
          <Trans>Reopen</Trans>
        </Button>
      )}
      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      {failed && (
        <span className="text-red-600 dark:text-red-400">
          <Trans>Could not update the issue.</Trans>
        </span>
      )}
    </div>
  );
  return (
    <>
      <div
        className="mt-1 max-w-xl overflow-hidden rounded-lg border border-border/60 bg-card"
        data-testid="issue-card"
      >
        <CardRow name="what" label={t`What`} onOpen={openIssue}>
          {reply.detail || reply.title}
        </CardRow>
        {reply.machine && (
          <CardRow name="machine" label={t`Machine`} onOpen={openMachine}>
            {reply.machine}
          </CardRow>
        )}
        {reply.cause && (
          <CardRow name="cause" label={t`Cause`} onOpen={openIssue}>
            <span className="font-mono text-xs">{reply.cause}</span>
          </CardRow>
        )}
        <CardRow name="status" label={t`Status`} onOpen={openIssue}>
          {issueStandingText({ ...reply, status })}
        </CardRow>
      </div>
      {line}
    </>
  );
}
