/**
 * The live event list. One row per envelope, expandable to the payload.
 *
 * An `ingest.*.sync.completed` row is the interesting case: it carries
 * `changed_ids` rather than one event per record, because the per-item lane is
 * deliberately not forwarded (it would storm the socket). So the row summarises
 * "N items changed" and the ids are there when expanded.
 */
import { useMemo, useState } from 'react';
import { splitNamespace } from '@sdk/tags/grammar';
import type { FlowEvent } from '@sdk/tags/EventBus';

interface Props {
  events: FlowEvent[];
  cap: number;
  paused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
}

/** Colour family from the tag root, so the eye groups without reading. The
 *  namespace is stripped first, or every `--ns--.*` tag groups as one family. */
function familyOf(tag: string): string {
  const [, bare] = splitNamespace(tag);
  return bare.split('.')[0] || 'other';
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '--:--:--'
    : d.toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 });
}

/** A one-line gist so the row says something without being expanded. */
function summarise(event: FlowEvent): string {
  const data: Record<string, unknown> = event.data ?? {};
  const changed = data.changed_ids;
  if (Array.isArray(changed)) {
    const counts = ['created', 'updated', 'unchanged']
      .map((k) => (typeof data[k] === 'number' ? `${data[k]} ${k}` : null))
      .filter(Boolean)
      .join(', ');
    return counts || `${changed.length} changed`;
  }
  for (const key of ['phase', 'kind', 'status', 'event', 'node_id']) {
    const value = data[key];
    if (typeof value === 'string' && value) return `${key}=${value}`;
  }
  return '';
}

export function EventFeed({ events, cap, paused, onTogglePause, onClear }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return events;
    return events.filter(
      (e) => e.tag.toLowerCase().includes(needle) || (e.target ?? '').toLowerCase().includes(needle),
    );
  }, [events, filter]);

  return (
    <div className="feed">
      <div className="feed-bar">
        <input
          className="feed-filter"
          value={filter}
          placeholder="filter by tag or target…"
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className={paused ? 'btn on' : 'btn'} onClick={onTogglePause}>
          {paused ? '▶ resume' : '⏸ pause'}
        </button>
        <button className="btn" onClick={onClear}>
          clear
        </button>
        <span className="feed-count">
          {shown.length}
          {shown.length !== events.length ? ` / ${events.length}` : ''}{' '}
          {events.length >= cap ? `(capped ${cap})` : ''}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="feed-empty">
          Nothing yet. The bus keeps no history of its own, so this shows what has been forwarded
          since the server started — plus anything that fires from now on.
        </p>
      ) : (
        <ol className="feed-list">
          {shown
            .slice()
            .reverse()
            .map((event) => {
              const open = openId === event.id;
              const gist = summarise(event);
              return (
                <li key={event.id} className={`feed-row fam-${familyOf(event.tag)}`}>
                  <button className="feed-head" onClick={() => setOpenId(open ? null : event.id)}>
                    <span className="t">{timeOf(event.timestamp)}</span>
                    <span className="tag">{event.tag}</span>
                    <span className="target">{event.target}</span>
                    {gist && <span className="gist">{gist}</span>}
                    <span className="chev">{open ? '▾' : '▸'}</span>
                  </button>
                  {open && (
                    <div className="feed-detail">
                      <dl>
                        <dt>id</dt>
                        <dd>{event.id}</dd>
                        <dt>origin</dt>
                        <dd>{event.ctx?.origin ?? '—'}</dd>
                        <dt>actor</dt>
                        <dd>{event.ctx?.actor ?? '—'}</dd>
                        <dt>scope</dt>
                        <dd>{event.ctx?.scope?.join(' ← ') || '—'}</dd>
                      </dl>
                      <pre>{JSON.stringify(event.data ?? {}, null, 2)}</pre>
                    </div>
                  )}
                </li>
              );
            })}
        </ol>
      )}
    </div>
  );
}
