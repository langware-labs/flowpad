import type { GitProvider, RepoSummary } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { useGitRepos } from '@src/hooks/use-git-providers';
import { formatRelative } from './relative-time';
import { Trans, useLingui } from '@lingui/react/macro';
import { GitFork, Loader2, Lock, RefreshCw, Search } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';

interface RepoPickerProps {
  provider: GitProvider;
  onSelect: (repo: RepoSummary) => void;
  enabled?: boolean;
  /** Restrict selectable rows without inventing a second repository picker. */
  allowedRoles?: ReadonlyArray<RepoSummary['role']>;
  /** Fired with the full fetched list (pre-filter), so a host can describe what
   *  the token actually reaches — e.g. whether private repos are visible —
   *  without issuing its own request. */
  onReposLoaded?: (repos: RepoSummary[]) => void;
  /** Offered in the ERROR branch only, as the way out of it. A failed repo
   *  list is usually a missing or revoked provider grant, and without this the
   *  panel states the failure and stops — every remaining affordance needs the
   *  same broken grant. The host owns the connect flow (it knows which provider
   *  and what to do after), so this is a button spec, not a connect
   *  implementation. */
  connectionAction?: {
    label: string;
    pending: boolean;
    onClick: () => void;
  };
}

function roleBadgeClass(role: RepoSummary['role']): string {
  switch (role) {
    case 'admin':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'write':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * Searchable, sorted table of repositories the user can access for the given
 * provider. Click a row → ``onSelect(repo)``. Filtering is client-side over
 * the full fetched list (5-min query cache via useGitRepos).
 *
 * Memoized: hosts render this beside their own inputs, so without it every
 * keystroke in a sibling URL box re-diffs a table that can hold hundreds of
 * rows. Its props are stable (a literal provider, `useCallback`'d handlers).
 */
function RepoPickerImpl({
  provider,
  onSelect,
  enabled = true,
  allowedRoles,
  onReposLoaded,
  connectionAction,
}: RepoPickerProps) {
  const { t } = useLingui();
  const { data: repos, isLoading, isError, error, refetch, isFetching } = useGitRepos(provider, enabled);

  // Hosts that want to describe the token's reach ("private repos included")
  // learn it from the fetch that already happened, rather than asking again.
  useEffect(() => {
    if (repos) onReposLoaded?.(repos);
  }, [repos, onReposLoaded]);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    const allowed = allowedRoles?.length ? repos.filter((repo) => allowedRoles.includes(repo.role)) : repos;
    const matched = q
      ? allowed.filter(
          (r) =>
            r.full_name.toLowerCase().includes(q) ||
            r.owner.toLowerCase().includes(q) ||
            r.name.toLowerCase().includes(q),
        )
      : allowed;
    // Sort: pushed_at desc (most recent first).
    return [...matched].sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || ''));
  }, [repos, query, allowedRoles]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t`Filter repos by owner or name…`}
            className="ps-7 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="shrink-0 rounded-md border border-border bg-background p-1.5 hover:bg-accent disabled:opacity-50"
          title={t`Refresh`}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* A five-column repo table has a min-content width of its own. Scroll it
          here (`overflow-auto` also makes this a shrinkable box) instead of
          letting it set the width of everything beside it. */}
      <div className="max-h-[280px] overflow-auto rounded-md border border-border">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> <Trans>Loading your repos…</Trans>
          </div>
        ) : isError || !repos ? (
          // `!repos` counts as a failure, not as an empty account. Without it a
          // failed fetch fell through to the empty state and asserted "No repos
          // accessible with this token" — blaming the user's token for what was
          // really a refused request.
          <div className="flex items-center justify-between gap-3 px-3 py-4 text-xs text-destructive">
            <span>
              <Trans>Couldn’t load your repos.</Trans> {error?.message ?? ''}
            </span>
            {connectionAction && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                disabled={connectionAction.pending}
                onClick={connectionAction.onClick}
                data-testid="repo-picker-connect"
              >
                {connectionAction.pending ? <Trans>Connecting…</Trans> : connectionAction.label}
              </Button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {query ? `No repos match "${query}"` : <Trans>No repos accessible with this token</Trans>}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-7"></TableHead>
                {/* The repo name is what the user is looking for, so it leads
                    and it is the biggest thing in the row; the owner is a
                    qualifier and rides behind it. */}
                <TableHead>
                  <Trans>Repo</Trans>
                </TableHead>
                <TableHead className="w-32">
                  <Trans>Owner</Trans>
                </TableHead>
                <TableHead className="w-20">
                  <Trans>Role</Trans>
                </TableHead>
                <TableHead className="w-20">
                  <Trans>Pushed</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((repo) => (
                <TableRow
                  key={repo.full_name}
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => onSelect(repo)}
                  data-testid={`repo-picker-row-${repo.full_name}`}
                >
                  <TableCell className="text-muted-foreground">
                    {repo.private ? <Lock className="h-3 w-3" /> : repo.fork ? <GitFork className="h-3 w-3" /> : null}
                  </TableCell>
                  <TableCell className="text-sm font-semibold">{repo.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{repo.owner}</TableCell>
                  <TableCell>
                    <span
                      className={`rounded px-1.5 py-px text-[10px] font-medium uppercase ${roleBadgeClass(repo.role)}`}
                    >
                      {repo.role}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatRelative(repo.pushed_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {repos && repos.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {filtered.length} of {repos.length} repos
        </div>
      )}
    </div>
  );
}

export const RepoPicker = memo(RepoPickerImpl);

export default RepoPicker;
