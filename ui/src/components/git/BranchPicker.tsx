import type { BranchSummary, RepoSummary } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { useGitBranches } from '@src/hooks/use-git-providers';
import { formatRelative } from './relative-time';
import { ArrowLeft, GitBranch, Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface BranchPickerProps {
  repo: RepoSummary;
  onSelect: (branch: BranchSummary) => void;
  onBack: () => void;
}

/** Move the default branch to the top of the list (mirrors GitHubConnectionDialog.sortBranches).
 *  Everything below it stays in the backend's order, which is most-recently-changed first. */
function pinDefault(branches: BranchSummary[], defaultName: string): BranchSummary[] {
  const i = branches.findIndex((b) => b.name === defaultName);
  if (i <= 0) return branches;
  const sorted = [...branches];
  const [pinned] = sorted.splice(i, 1);
  sorted.unshift(pinned);
  return sorted;
}

export function BranchPicker({ repo, onSelect, onBack }: BranchPickerProps) {
  const { data: branches, isLoading, isError, error } = useGitBranches(repo);
  const [query, setQuery] = useState('');
  const { t } = useLingui();

  const list = useMemo(() => {
    const base = branches ?? [];
    const q = query.trim().toLowerCase();
    const matched = q ? base.filter((b) => b.name.toLowerCase().includes(q)) : base;
    return pinDefault(matched, repo.default_branch);
  }, [branches, query, repo.default_branch]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="font-medium">{repo.full_name}</span>
        <span className="text-muted-foreground">
          <Trans>· pick a branch</Trans>
        </span>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t`Filter branches…`}
          className="ps-7 text-sm"
          autoFocus
        />
      </div>

      <div className="max-h-[240px] overflow-y-auto rounded-md border border-border">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> <Trans>Loading branches…</Trans>
          </div>
        ) : isError ? (
          <div className="px-3 py-4 text-xs text-destructive">
            Failed to load branches: {(error)?.message ?? 'unknown error'}
          </div>
        ) : list.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {query ? `No branches match "${query}"` : 'No branches'}
          </div>
        ) : (
          <ul>
            {list.map((branch) => (
              <li
                key={branch.name}
                className="flex cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-xs last:border-b-0 hover:bg-accent"
                onClick={() => onSelect(branch)}
              >
                <GitBranch className="h-3 w-3 text-muted-foreground" />
                <span className="flex-1 font-mono">{branch.name}</span>
                {branch.name === repo.default_branch && (
                  <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase text-muted-foreground">
                    <Trans>default</Trans>
                  </span>
                )}
                {branch.protected && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] uppercase text-amber-700 dark:text-amber-300">
                    <Trans>protected</Trans>
                  </span>
                )}
                {/* The list is ordered by this, so show it — otherwise the order looks arbitrary. */}
                <span className="w-16 shrink-0 text-end text-[10px] text-muted-foreground">
                  {formatRelative(branch.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default BranchPicker;
