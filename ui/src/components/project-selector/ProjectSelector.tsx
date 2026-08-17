import { Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export interface ProjectSelectorItem {
  /** Stable identifier the consumer cares about (encoded_name, project id, etc). */
  id: string;
  name: string;
  /** Full filesystem path, shown as the row's sub-line. */
  path?: string;
  /** ISO timestamp used for the "ago" label. */
  modifiedAt?: string | null;
  /** Epoch-ms sort key, precomputed at the mapping boundary via
   *  `projectRecencyMs` (UI-open recency wins, `modifiedAt` falls back). */
  recencyMs?: number | null;
}

export interface ProjectSelectorProps {
  projects: ProjectSelectorItem[];
  selectedId: string | null;
  /** Called with the picked id, or null when the current selection is toggled off. */
  onSelect: (id: string | null) => void;
  isLoading?: boolean;
  /** Override the empty-state copy (e.g. inside a modal). */
  emptyMessage?: string;
  /**
   * Ids to hide from the list (e.g. projects that are already open in the
   * hosting surface). Matched exactly against item `id`s — derive both from
   * the same key (see `projectListToSelectorItems`). Applied before the text
   * filter.
   */
  excludeIds?: ReadonlyArray<string>;
}

function timeAgo(iso?: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return null;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Concise project picker: filter input on top, then a list of `name` rows with
 * the full `path` as a sub-line and an "X ago" label aligned to the right.
 * Sorted by `recencyMs` desc. Renders no card chrome — the host controls the
 * outer container (panel, modal, popover).
 */
export function ProjectSelector({
  projects,
  selectedId,
  onSelect,
  isLoading = false,
  emptyMessage,
  excludeIds,
}: ProjectSelectorProps) {
  const { t } = useLingui();
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const excluded = excludeIds?.length ? new Set(excludeIds) : null;
    const q = filter.trim().toLowerCase();
    return projects
      .filter((p) => {
        if (excluded?.has(p.id)) return false;
        if (!q) return true;
        return p.name.toLowerCase().includes(q) || (p.path ?? '').toLowerCase().includes(q);
      })
      .sort((a, b) => (b.recencyMs ?? 0) - (a.recencyMs ?? 0));
  }, [projects, filter, excludeIds]);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t`Filter projects…`}
          className="h-8 w-full rounded-md border border-input bg-background pe-2 ps-8 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && projects.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              <Trans>Loading…</Trans>
            </span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {filter ? t`No matches` : (emptyMessage ?? t`No projects`)}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((p) => {
              const isSelected = selectedId === p.id;
              const ago = timeAgo(p.modifiedAt);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelect(isSelected ? null : p.id)}
                  data-testid={`project-selector-row-${p.id}`}
                  className={`flex w-full flex-col items-stretch gap-0.5 rounded px-2 py-1.5 text-start transition-colors ${
                    isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                  }`}
                  title={p.path || p.name}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    {ago && <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">{ago}</span>}
                  </div>
                  {p.path && <div className="truncate font-mono text-[10px] text-muted-foreground">{p.path}</div>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default ProjectSelector;
