/**
 * Signals — the global event surface.
 *
 * Global by construction: no scope on the dock and SIGNALS is deliberately kept
 * out of SCOPE_SEEDED_VIEWS, so switching project never changes what this shows.
 * Events and data sources are properties of the instance, not of a project.
 *
 * Three panes, one question each:
 *   Feed    — is anything happening?         (live bus, seeded from the ring)
 *   Inject  — what happens if I fire this?   (POST /debug/emit_tag)
 *   Sources — are the pullers actually alive? (DataSource + its cursors)
 *
 * Only the tags in FORWARDED_TAG_PATTERNS reach the app at all — today
 * `graph_workflow.*` and `ingest.*.sync.*`. `entity.*` is deliberately absent:
 * it fires on every entity write and forwarding it would storm the socket
 * (docs/flow-events.md phase 3). An `ingest.*.sync.completed` row carries
 * `changed_ids`, so per-item detail is expanded on demand rather than streamed.
 */
import { useCallback, useEffect, useState } from 'react';
import { DataSource, QueryRequest } from '@sdk';
import apiClient from '@sdk/client';
import { useOnTag } from '@sdk/react/hooks';
import type { FlowEvent } from '@sdk/tags/EventBus';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { SourcesPane } from './SourcesPane';
import { EventFeed } from './EventFeed';
import { InjectorPanel } from './InjectorPanel';
import './signals.css';

/** Fallback ring size until the server reports its own RECENT_EVENTS_CAP, so
 *  the seed and live traffic behave the same either side of a reload. There is
 *  no virtualization library in this repo — cap the list, don't add one. */
const DEFAULT_FEED_CAP = 200;

const sourcesQuery = new QueryRequest({
  type: DataSource.type,
  scope: [],
  name: 'signals:data_sources',
});

interface RecentEventsResponse {
  events: FlowEvent[];
  count: number;
  cap: number;
  patterns: string[];
}

export function SignalsView() {
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [cap, setCap] = useState(DEFAULT_FEED_CAP);
  const [paused, setPaused] = useState(false);
  const { data: sources = [], refetch } = useEntitiesQuery<DataSource>(sourcesQuery);
  const reloadSources = useCallback(() => {
    void refetch();
  }, [refetch]);

  // Seed from the server ring: the bus persists nothing, so without this the
  // feed sits blank until the next event happens to fire.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await apiClient.get('/debug/recent_events')) as RecentEventsResponse | null;
        if (!alive || !data) return;
        setCap(data.cap || DEFAULT_FEED_CAP);
        setEvents((data.events ?? []).slice(-(data.cap || DEFAULT_FEED_CAP)));
        setPatterns(data.patterns ?? []);
      } catch {
        // The feed still works live — a missing seed is not worth shouting about.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useOnTag('*', (event) => {
    if (paused) return;
    setEvents((prev) => [...prev, event].slice(-cap));
  });

  return (
    <div className="signals">
      <header className="signals-head">
        <h1>
          <span className="dot live" /> Signals
        </h1>
        <p className="sub">
          The instance-wide event bus. Forwarded:{' '}
          {patterns.length ? patterns.map((p) => <code key={p}>{p}</code>) : <em>loading…</em>}
        </p>
      </header>

      <div className="signals-body">
        <section className="signals-main">
          <EventFeed
            events={events}
            cap={cap}
            paused={paused}
            onTogglePause={() => setPaused((p) => !p)}
            onClear={() => setEvents([])}
          />
        </section>
        <aside className="signals-side">
          <InjectorPanel />
          <SourcesPane sources={sources} onChanged={reloadSources} />
        </aside>
      </div>
    </div>
  );
}

export default SignalsView;
