import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, CircleAlert, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Issue, type IssueManualStatus, type IssueReplyMeta, type IssueStatus } from '@sdk';
import { isIssueActive } from '@sdk/entities/issue';
import { fixPointer } from '@src/components/asset-counters/issue-counters';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

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

/**
 * Under an issue's message in a Monitoring conversation: severity, title, status, how many times it happened,
 * the fix, and the manual moves (work on it, close it, reopen it). The hub updates the message itself, so the
 * status here follows `reply.status`; a click shows the new status at once.
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
  return (
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
          onClick={() => navigation.openDockOnThisPage(pointer)}
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
}
