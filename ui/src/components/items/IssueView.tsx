import { Trans } from '@lingui/react/macro';
import { Issue, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useMemo } from 'react';
import { IssueFixButton } from '@src/components/asset-counters/issue-counters';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { ItemHeader } from './ItemHeader';
import { issueState } from './item-state';

/**
 * An issue's own page, on hub and desktop: what is wrong, how often and since when, what it is about,
 * and its fix. The card opens this — never straight to the subject, which the person may not be
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
  const since = formatTimeAgo(new Date(issue.opened_at * 1000));
  const last = issue.last_notified_at ? formatTimeAgo(new Date(issue.last_notified_at * 1000)) : null;
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
      <div className="rounded-lg border border-border p-4 text-sm">
        <p className="text-muted-foreground">
          <Trans>
            Happened {issue.count}× · first {since}
          </Trans>
          {last && (
            <>
              {' · '}
              <Trans>last notified {last}</Trans>
            </>
          )}
        </p>
        <p className="mt-2 text-muted-foreground">
          <Trans>About</Trans> <code className="rounded bg-muted px-1 font-mono text-xs">{issue.subject_typeid}</code>
        </p>
      </div>
    </div>
  );
}
