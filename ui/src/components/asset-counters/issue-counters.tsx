import { Deployment, Issue, QueryRequest, TypeId, type IDockPointer } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';
import { formatRelative } from '@src/components/git/relative-time';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { tryParseDock } from '@src/navigation/try-parse-dock';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { CHIP_CLASS } from './AssetCounterRow';
import type { AssetCounterGroup } from './types';

/** Every issue the caller can see; the open ones are picked here so the count and the table agree. */
const ALL_ISSUES = new QueryRequest({ type: Issue.type, scope: [], query: null, name: 'assetCounters:issues' });

type IssueLike = Pick<Issue, 'severity' | 'status'>;

export interface IssueCounts {
  open: number;
  errors: number;
  warnings: number;
}

export function openIssues<T extends IssueLike>(issues: T[]): T[] {
  return issues.filter((i) => i.status === 'open');
}

export function countIssues(issues: IssueLike[]): IssueCounts {
  const open = openIssues(issues);
  const errors = open.filter((i) => i.severity === 'error').length;
  return { open: open.length, errors, warnings: open.length - errors };
}

/** The Issues chip shows only while something is open — no issues, no chip. */
export function showIssuesChip(counts: IssueCounts): boolean {
  return counts.open > 0;
}

/** The open issues about `typeid` (its subject or one it stops), errors first. */
export function issuesConcerning<T extends IssueLike & Pick<Issue, 'subject_typeid' | 'affected'>>(
  issues: T[],
  typeid: string,
): T[] {
  return openIssues(issues)
    .filter((i) => i.subject_typeid === typeid || i.affected.includes(typeid))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** Where a fix button goes: its dock URL parsed, or null when it is not one. */
export function fixPointer(issue: Pick<Issue, 'fix'>): IDockPointer | null {
  const raw = issue.fix?.pointer;
  if (!raw) return null;
  if (raw.startsWith('/')) return tryParseDock(raw);
  // The hub names WHAT to fix by its typeid (a budget, a deployment): open that entity's own editor.
  try {
    const typeId = new TypeId(raw);
    // A deployment lives in the world view, not as an asset of its own.
    if (typeId.type === Deployment.type) return Deployment.dockPointerFor(typeId.id);
    return DockPointer.forAssetEditorByTypeId(typeId.type, typeId);
  } catch {
    return null;
  }
}

export const SEVERITY_DOT: Record<Issue['severity'], string> = { error: 'bg-red-500', warning: 'bg-amber-400' };

export function SeverityDot({ severity }: { severity: Issue['severity'] }) {
  return <span className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[severity])} />;
}

export function IssueFixButton({ issue, className }: { issue: Issue; className?: string }) {
  const { navigation } = useDockNavigation();
  const pointer = fixPointer(issue);
  if (!issue.fix || !pointer) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn('h-7', className)}
      onClick={(e) => {
        e.stopPropagation();
        navigation.openDockOnThisPage(pointer);
      }}
      data-testid={`issue-fix-${issue.id}`}
    >
      {issue.fix.label}
    </Button>
  );
}

export function useIssues(): { issues: Issue[]; isLoading: boolean } {
  const { data = [], isLoading } = useEntitiesQuery<Issue>(ALL_ISSUES);
  return { issues: data, isLoading };
}

export const hubIssueCounterGroup: AssetCounterGroup<Issue> = {
  id: 'hub-issues',
  type: Issue.type,
  useCounters: () => {
    const { issues, isLoading } = useIssues();
    const open = useMemo(() => openIssues(issues), [issues]);
    return useMemo(
      () => [
        {
          key: 'all',
          label: <Trans>Issues</Trans>,
          description: <Trans>Everything open that needs fixing</Trans>,
          items: open,
          isLoading,
        },
        {
          key: 'errors',
          label: <Trans>Errors</Trans>,
          description: <Trans>Open issues that stop something from working</Trans>,
          items: open.filter((i) => i.severity === 'error'),
          isLoading,
        },
        {
          key: 'warnings',
          label: <Trans>Warnings</Trans>,
          description: <Trans>Open issues that will stop something soon</Trans>,
          items: open.filter((i) => i.severity === 'warning'),
          isLoading,
        },
      ],
      [open, isLoading],
    );
  },
  itemKey: (i) => i.id,
  searchText: (i) => [i.title, i.detail, i.kind, i.subject_typeid].filter(Boolean).join(' '),
  itemPointer: fixPointer,
  card: (i) => ({
    title: i.title,
    description: i.detail,
    status: { label: i.severity === 'error' ? <Trans>Error</Trans> : <Trans>Warning</Trans>, active: false },
    footer: <IssueFixButton issue={i} />,
  }),
  columns: [
    {
      key: 'severity',
      header: '',
      cell: (i) => <SeverityDot severity={i.severity} />,
      className: 'w-6',
    },
    {
      key: 'title',
      header: <Trans>Issue</Trans>,
      cell: (i) => <span className="block truncate font-medium text-foreground">{i.title}</span>,
      className: 'w-[30%] max-w-0',
    },
    {
      key: 'detail',
      header: <Trans>Detail</Trans>,
      cell: (i) => (
        <span className="block truncate text-muted-foreground" title={i.detail}>
          {i.detail}
        </span>
      ),
      className: 'w-[45%] max-w-0',
    },
    {
      key: 'since',
      header: <Trans>Since</Trans>,
      cell: (i) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {i.opened_at ? formatRelative(new Date(i.opened_at * 1000).toISOString()) : '—'}
        </span>
      ),
    },
    {
      key: 'fix',
      header: '',
      cell: (i) => <IssueFixButton issue={i} />,
    },
  ],
};

/**
 * The home's Issues chip: `Issues ● n errors ● n warnings`, opening the issues table. Rendered only
 * while something is open — Home shows no banners and no empty chip.
 */
export function IssuesSummaryChip() {
  const { navigation } = useDockNavigation();
  const { issues } = useIssues();
  const counts = useMemo(() => countIssues(issues), [issues]);
  if (!showIssuesChip(counts)) return null;
  return (
    <button
      type="button"
      onClick={() => navigation.openAssetList(hubIssueCounterGroup.id, 'all')}
      className={CHIP_CLASS}
      data-testid={`summary-chip-${hubIssueCounterGroup.id}`}
    >
      <span className="truncate text-muted-foreground group-hover:text-foreground">
        <Trans>Issues</Trans>
      </span>
      {counts.errors > 0 && (
        <span className="flex items-center gap-1" data-testid="issues-chip-errors">
          <SeverityDot severity="error" />
          <span className="font-semibold tabular-nums text-foreground">{counts.errors}</span>
        </span>
      )}
      {counts.warnings > 0 && (
        <span className="flex items-center gap-1" data-testid="issues-chip-warnings">
          <SeverityDot severity="warning" />
          <span className="font-semibold tabular-nums text-foreground">{counts.warnings}</span>
        </span>
      )}
    </button>
  );
}

/** A subject page's open issues, in place: a red (error) or amber (warning) banner with its fix. */
export function IssueBanners({ typeid, className }: { typeid: string; className?: string }) {
  const { issues } = useIssues();
  const mine = useMemo(() => issuesConcerning(issues, typeid), [issues, typeid]);
  if (!mine.length) return null;
  return (
    <div className={cn('flex flex-col', className)}>
      {mine.map((issue) => (
        <div
          key={issue.id}
          role="alert"
          className={cn(
            'flex flex-wrap items-center gap-3 border-b px-6 py-2.5 text-sm',
            issue.severity === 'error'
              ? 'border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-300',
          )}
          data-testid={`issue-banner-${issue.id}`}
          data-severity={issue.severity}
        >
          <SeverityDot severity={issue.severity} />
          <span className="font-medium">{issue.title}</span>
          {issue.detail && <span className="min-w-0 flex-1 truncate opacity-80">{issue.detail}</span>}
          <IssueFixButton issue={issue} className="ms-auto" />
        </div>
      ))}
    </div>
  );
}
