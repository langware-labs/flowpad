import { useLingui } from '@lingui/react/macro';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Search } from 'lucide-react';
import type { SortKey } from './discover-model';

const ALL = '__all__';

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors ${
        active ? 'border-transparent bg-primary text-primary-foreground' : 'border-border bg-muted text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/** Search, type chips, project facet and sort — the whole filter state, controlled by the page. */
export function DiscoverToolbar({
  query,
  onQuery,
  type,
  onType,
  types,
  projectId,
  onProject,
  projects,
  sort,
  onSort,
  count,
}: {
  query: string;
  onQuery: (q: string) => void;
  type: string | null;
  onType: (t: string | null) => void;
  types: { type: string; count: number }[];
  projectId: string | null;
  onProject: (id: string | null) => void;
  projects: { id: string; name: string; count: number }[];
  sort: SortKey;
  onSort: (s: SortKey) => void;
  count: number;
}) {
  const { t } = useLingui();
  return (
    <section className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="discover-toolbar">
      <div className="relative min-w-[200px] flex-1">
        <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t`Search published assets…`}
          className="h-8 w-full rounded-md border border-border bg-background pe-3 ps-8 text-sm outline-none focus:border-primary"
          data-testid="discover-search"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {types.map(({ type: ty, count: c }) => {
          const Icon = iconForType(ty);
          return (
            <FilterChip key={ty} active={type === ty} onClick={() => onType(type === ty ? null : ty)}>
              <Icon className="h-3 w-3" /> {labelForType(ty)}
              <span className="opacity-60">{c}</span>
            </FilterChip>
          );
        })}
      </div>
      {projects.length > 1 && (
        <Select value={projectId ?? ALL} onValueChange={(v) => onProject(v === ALL ? null : v)}>
          <SelectTrigger className="h-8 w-[180px] text-xs" data-testid="discover-project-facet">
            <SelectValue placeholder={t`All projects`} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t`All projects`}</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} <span className="opacity-60">{p.count}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select value={sort} onValueChange={(v) => onSort(v as SortKey)}>
        <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="discover-sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="published_at">{t`Newest first`}</SelectItem>
          <SelectItem value="name">{t`Name`}</SelectItem>
          <SelectItem value="type">{t`Type`}</SelectItem>
        </SelectContent>
      </Select>
      <span className="font-mono text-xs text-muted-foreground">{count}</span>
    </section>
  );
}
