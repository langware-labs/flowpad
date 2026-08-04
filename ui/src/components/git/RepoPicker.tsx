import type { GitProvider, RepoSummary } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { useGitRepos } from '@src/hooks/use-git-providers';
import { errorMessage } from '@src/lib/error-message';
import { Trans, useLingui } from '@lingui/react/macro';
import { GitFork, Loader2, Lock, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

interface RepoPickerProps {
  provider: GitProvider;
  onSelect: (repo: RepoSummary) => void;
  enabled?: boolean;
  allowedRoles?: RepoSummary['role'][];
  connectionAction?: {
    label: string;
    pending: boolean;
    onClick: () => void;
  };
}

function formatRelative(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso.slice(0, 10);
  const ageMs = Date.now() - then;
  const days = Math.floor(ageMs / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
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
 */
export function RepoPicker({ provider, onSelect, enabled = true, allowedRoles, connectionAction }: RepoPickerProps) {
  const { t } = useLingui();
  const { data: repos, isLoading, isError, error, refetch, isFetching } = useGitRepos(provider, enabled);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    const eligible = allowedRoles ? repos.filter((repo) => allowedRoles.includes(repo.role)) : repos;
    const matched = q
      ? eligible.filter(
          (r) =>
            r.full_name.toLowerCase().includes(q) ||
            r.owner.toLowerCase().includes(q) ||
            r.name.toLowerCase().includes(q),
        )
      : eligible;
    // Sort: pushed_at desc (most recent first).
    return [...matched].sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || ''));
  }, [allowedRoles, repos, query]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t`Filter repos by owner or name…`}
            className="pl-7 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="rounded-md border border-border bg-background p-1.5 hover:bg-accent disabled:opacity-50"
          title={t`Refresh`}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="max-h-[280px] overflow-y-auto rounded-md border border-border">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> <Trans>Loading your repos…</Trans>
          </div>
        ) : isError ? (
          <div className="flex items-center justify-between gap-3 px-3 py-4 text-xs text-destructive">
            <span>
              <Trans>Failed to load repos: {errorMessage(error, t`unknown error`)}</Trans>
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
                <TableHead>
                  <Trans>Owner</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Repo</Trans>
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
                  data-testid={`repo-picker-row-${repo.full_name}`}
                  onClick={() => onSelect(repo)}
                >
                  <TableCell className="text-muted-foreground">
                    {repo.private ? <Lock className="h-3 w-3" /> : repo.fork ? <GitFork className="h-3 w-3" /> : null}
                  </TableCell>
                  <TableCell className="text-xs">{repo.owner}</TableCell>
                  <TableCell className="text-xs font-medium">{repo.name}</TableCell>
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

export default RepoPicker;
