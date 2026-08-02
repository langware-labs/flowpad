/**
 * Run filters — the facets that actually narrow a run list.
 *
 * A free-text box alone was the whole filter before, which is useless for the
 * two questions people actually ask: "what failed?" and "what did THIS agent
 * do?". Status and agent are therefore one-click chips built from the loaded
 * page, so a facet only appears when it would match something.
 *
 * These are CLIENT-side facets over the page, by design. The server-side
 * narrowing (`scope`) is a different thing and a different mechanism: scope
 * keys are exact column/JSON matches pushed into SQL, while `badge` is derived
 * from three fields and would need a nested boolean query to filter honestly.
 * The header renders the active scope as a removable pill so the two never
 * look like one control.
 */
import { useMemo } from 'react';
import { X } from 'lucide-react';
import { PROCESS_RUN_SCOPE_KEYS, type ProcessRunScope } from '@src/navigation/DockPointer';
import type { RunSummary } from './RunRow';

export interface RunFilterState {
  text: string;
  /** Empty = every status. */
  badges: readonly string[];
  agent: string;
}

export const NO_RUN_FILTERS: RunFilterState = { text: '', badges: [], agent: '' };

/** Status chips, in the order a person triages them. */
const BADGES = ['failed', 'running', 'done', 'queued'] as const;

export function matchesFilters(run: RunSummary, f: RunFilterState): boolean {
  if (f.badges.length && !f.badges.includes(run.badge)) return false;
  if (f.agent && run.agent !== f.agent) return false;
  const needle = f.text.trim().toLowerCase();
  if (!needle) return true;
  return [run.name, run.agent, run.prompt, run.flow_id].some((v) =>
    (v ?? '').toLowerCase().includes(needle),
  );
}

export function RunFilters({
  runs,
  value,
  onChange,
  shown,
  scope,
  onClearScope,
}: {
  runs: RunSummary[];
  value: RunFilterState;
  onChange: (next: RunFilterState) => void;
  shown: number;
  scope: ProcessRunScope;
  onClearScope?: () => void;
}) {
  // Counts come from the loaded page, so a chip never promises rows it can't
  // show — and a status nobody has doesn't take up a slot.
  const counts = useMemo(() => {
    const byBadge = new Map<string, number>();
    const byAgent = new Map<string, number>();
    for (const r of runs) {
      byBadge.set(r.badge, (byBadge.get(r.badge) ?? 0) + 1);
      if (r.agent) byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + 1);
    }
    return { byBadge, byAgent };
  }, [runs]);

  const toggleBadge = (badge: string) =>
    onChange({
      ...value,
      badges: value.badges.includes(badge)
        ? value.badges.filter((b) => b !== badge)
        : [...value.badges, badge],
    });

  const scopePills = PROCESS_RUN_SCOPE_KEYS.filter((k) => scope[k]);
  const dirty = value.text || value.badges.length || value.agent;

  return (
    <div className="runs-bar">
      <div className="runs-bar-row">
        <input
          className="runs-filter"
          value={value.text}
          placeholder="filter runs…"
          onChange={(e) => onChange({ ...value, text: e.target.value })}
        />
        <span className="runs-count">{shown}</span>
        {dirty && (
          <button className="lnk" onClick={() => onChange(NO_RUN_FILTERS)} title="clear filters">
            clear
          </button>
        )}
      </div>

      {scopePills.length > 0 && (
        <div className="runs-bar-row">
          {scopePills.map((key) => (
            <span key={key} className="chip scope" title={`${key} = ${scope[key]}`}>
              {key.replace(/_id$/, '')}: {shorten(scope[key]!)}
              {onClearScope && (
                <button className="chip-x" onClick={onClearScope} title="show every run">
                  <X size={9} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="runs-bar-row facets">
        {BADGES.filter((b) => counts.byBadge.get(b)).map((badge) => (
          <button
            key={badge}
            className={`facet b-${badge}${value.badges.includes(badge) ? ' on' : ''}`}
            onClick={() => toggleBadge(badge)}
          >
            {badge} <b>{counts.byBadge.get(badge)}</b>
          </button>
        ))}
        {counts.byAgent.size > 1 && (
          <select
            className="facet select"
            value={value.agent}
            onChange={(e) => onChange({ ...value, agent: e.target.value })}
          >
            <option value="">every agent</option>
            {[...counts.byAgent.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([agent, n]) => (
                <option key={agent} value={agent}>
                  {agent} ({n})
                </option>
              ))}
          </select>
        )}
      </div>
    </div>
  );
}

/** An id is unreadable at full length in a pill and unmistakable at eight. */
function shorten(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
