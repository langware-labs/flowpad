/**
 * Deployed pullers, and whether they are actually alive.
 *
 * "Alive" is not one field. A source can be enabled and still never poll —
 * `config_error` makes `is_due` refuse it permanently, which is exactly the
 * failure this pane exists to make visible. So the row shows health, the
 * countdown to the next poll, AND an explicit "parked" state when those
 * disagree.
 *
 * Icons come from the type registry via iconForType, never a glyph chosen here.
 */
import { useCallback, useMemo, useState } from 'react';
import { DataSource, DataSourceCursor, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { timeSince, timeUntil } from '@src/utils/duration';

interface Props {
  sources: DataSource[];
  onChanged: () => void;
}

const HEALTH_LABEL: Record<string, string> = {
  ok: 'ok',
  never_synced: 'never synced',
  transient_error: 'retrying',
  config_error: 'needs attention',
};


function SourceRow({ source, onChanged }: { source: DataSource; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const Icon = iconForType(DataSource.type);

  const cursorQuery = useMemo(
    () =>
      new QueryRequest({
        type: DataSourceCursor.type,
        scope: [],
        query: { data_source_id: source.id },
        name: `signals:cursors:${source.id}`,
      }),
    [source.id],
  );
  const { data: cursors = [] } = useEntitiesQuery<DataSourceCursor>(cursorQuery, { enabled: open });

  /** Run an action and show whatever note it returns. */
  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(label);
      setNote(null);
      try {
        setNote(await fn());
        onChanged();
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  // Enabled, but `is_due` will still refuse it. Without calling this out the
  // row reads as healthy-but-idle and the user waits forever.
  const parked = source.enabled && source.health === 'config_error';

  return (
    <li className={`src health-${source.health}`}>
      <button className="src-head" onClick={() => setOpen((o) => !o)}>
        <Icon className="src-icon" size={15} />
        <span className="src-name">{source.name || source.provider || source.id.slice(0, 8)}</span>
        <span className={`pill h-${source.health}`}>{HEALTH_LABEL[source.health] ?? source.health}</span>
        {!source.enabled && <span className="pill off">disabled</span>}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>

      <div className="src-meta">
        <span title="last successful sync">synced {timeSince(source.last_synced_at)}</span>
        <span title="next scheduled poll">
          {source.enabled ? `next ${timeUntil(source.next_poll_at)}` : 'paused'}
        </span>
        <span className="prov">{source.provider}</span>
      </div>

      {parked && (
        <p className="warn parked">
          Parked: a <code>config_error</code> source is skipped by the scheduler, so it will not
          poll again on its own. <strong>Poll now</strong> clears the latch.
          {source.error_detail ? ` (${source.error_detail})` : ''}
        </p>
      )}

      {open && (
        <div className="src-body">
          <div className="src-actions">
            <button
              className="btn"
              disabled={!!busy}
              onClick={() => void run('poll', async () => (await source.pollNow()).detail)}
            >
              {busy === 'poll' ? '…' : 'Poll now'}
            </button>
            <button
              className="btn"
              disabled={!!busy}
              title="Forget position AND drop the records — the two together are what makes a re-fetch visible"
              onClick={() =>
                void run('refetch', async () => {
                  // Purge first: clearing cursors alone changes nothing, because
                  // ids are deterministic and the content digest still matches,
                  // so every re-read is suppressed.
                  const { removed } = await source.purgeItems();
                  const { streams } = await source.resetCursors();
                  return `dropped ${removed} records, reset ${streams} streams — re-fetch on the next poll`;
                })
              }
            >
              {busy === 'refetch' ? '…' : 'Re-fetch everything'}
            </button>
          </div>
          {note && <p className="ok">{note}</p>}

          <h4>Streams</h4>
          {cursors.length === 0 ? (
            <p className="muted">No cursors yet — this source has not polled.</p>
          ) : (
            <ul className="cursors">
              {cursors.map((c) => (
                <li key={c.id} className={`cur h-${c.health}`}>
                  <span className="k" title={c.stream_key}>
                    {c.stream_label || c.stream_key}
                  </span>
                  <span className={`pill h-${c.health}`}>{HEALTH_LABEL[c.health] ?? c.health}</span>
                  <span className="muted">{timeSince(c.last_synced_at)}</span>
                  {c.consecutive_failures > 0 && (
                    <span className="pill bad">{c.consecutive_failures}× failed</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function SourcesPane({ sources, onChanged }: Props) {
  return (
    <section className="panel sources">
      <h2>
        Data sources <span className="muted">{sources.length}</span>
      </h2>
      {sources.length === 0 ? (
        <p className="muted">
          No data sources configured. One is created per remote feed or account; the poller then
          syncs it on the heartbeat.
        </p>
      ) : (
        <ul className="src-list">
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}
