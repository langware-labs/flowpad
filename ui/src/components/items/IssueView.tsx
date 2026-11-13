import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Issue, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useMemo, type ReactNode } from 'react';
import { IssueFixButton } from '@src/components/asset-counters/issue-counters';
import { issueDuration } from '@src/components/conversation/IssueReplyLine';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { ItemHeader } from './ItemHeader';
import { issueState } from './item-state';

function eventLabel(what: string): string {
  switch (what) {
    case 'opened':
      return t`Opened`;
    case 'seen_again':
      return t`Happened again`;
    case 'reopened':
      return t`Came back`;
    case 'resolved':
      return t`Resolved by itself`;
    case 'status':
      return t`Status changed`;
    default:
      return what;
  }
}

function Section({ title, testId, children }: { title: ReactNode; testId: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4 text-sm" data-testid={testId}>
      <div className="mb-2 text-sm font-semibold text-foreground">{title}</div>
      {children}
    </div>
  );
}

function Fact({ value, label }: { value: string; label: ReactNode }) {
  return (
    <div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

/**
 * An issue's own page, on hub and desktop — its report: what is wrong, what happened and when, the
 * technical cause, who was affected, what it is about, and its fix. The card opens this — never straight to the subject, which the person may not be
 * allowed to read (a budget they draw on but do not own).
 */
export function IssueView({ id }: { id: string }) {
  const typeId = useMemo(() => new TypeId(Issue.type, id), [id]);
  const { data: issue, isLoading } = useEntity<Issue>(typeId);
  if (isLoading || !issue) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {isLoading ? <Trans>Loading…</Trans> : <Trans>This issue is gone.</Trans>}
      </p>
    );
  }
  const last = issue.last_notified_at ? formatTimeAgo(new Date(issue.last_notified_at * 1000)) : null;
  const ended = issue.resolved_at !== null;
  const took = issueDuration(issue.reopened_at ?? issue.opened_at, issue.resolved_at ?? Date.now() / 1000);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8" data-testid="issue-view">
      <ItemHeader
        kind={<Trans>Issue</Trans>}
        item={{
          title: issue.title,
          icon: iconForType(Issue.type),
          state: issueState(issue.status, issue.severity),
          description: issue.detail,
          at: { date: new Date(issue.opened_at * 1000), verb: 'opened' },
          footer: <IssueFixButton issue={issue} />,
        }}
      />
      <Section title={<Trans>What happened</Trans>} testId="issue-report-events">
        {issue.events.length > 0 && (
          <table className="w-full">
            <tbody>
              {issue.events.map((event, i) => (
                <tr key={i} className="border-b border-border/40 last:border-b-0">
                  <td className="whitespace-nowrap py-1.5 pe-4 align-top font-mono text-xs text-muted-foreground">
                    {new Date(event.at * 1000).toLocaleString()}
                  </td>
                  <td className="py-1.5 pe-4 align-top text-sm text-foreground">{eventLabel(event.what)}</td>
                  <td className="py-1.5 align-top font-mono text-xs text-muted-foreground">{event.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {last && (
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans>last notified {last}</Trans>
          </p>
        )}
      </Section>
      {issue.cause && (
        <Section title={<Trans>Real cause</Trans>} testId="issue-report-cause">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs text-foreground">
            {issue.cause}
          </pre>
        </Section>
      )}
      <Section title={<Trans>Who was affected</Trans>} testId="issue-report-affected">
        <div className="grid grid-cols-3 gap-3">
          <Fact value={issue.machine || '—'} label={<Trans>machine</Trans>} />
          <Fact value={took || '—'} label={ended ? <Trans>it lasted</Trans> : <Trans>open for</Trans>} />
          <Fact value={`${issue.count}×`} label={<Trans>times it happened</Trans>} />
        </div>
      </Section>
      <Section title={<Trans>Evidence</Trans>} testId="issue-report-evidence">
        <ul className="flex flex-col gap-1">
          {[issue.subject_typeid, ...issue.affected, issue.typeId.toString()].filter(Boolean).map((typeid) => (
            <li key={typeid}>
              <code className="rounded bg-muted px-1 font-mono text-xs">{typeid}</code>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
