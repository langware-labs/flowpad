/**
 * The bus's live stream, narrowed to an event type and/or a subject — the part of the event bus that is about
 * "what just happened". The bus page shows it under its catalog; a data source's page shows it narrowed to that
 * source (`target = data_source:<id>`). Seeded from the backend ring (the bus keeps no history), then live.
 */
import { Trans } from '@lingui/react/macro';
import { recentBusEvents, tagMatches, targetMatches } from '@sdk';
import { useOnTag } from '@sdk/react/hooks';
import type { FlowEvent } from '@sdk/tags/EventBus';
import { Pause, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@src/components/ui/button';

/** How many events the live stream keeps in view. */
const STREAM_CAP = 200;

export function BusStream({ tag, target }: { tag?: string | null; target?: string | null }) {
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let alive = true;
    void recentBusEvents()
      .then((r) => alive && setEvents(r.events.slice(-STREAM_CAP)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  useOnTag('*', (event) => {
    if (!paused) setEvents((prev) => [...prev.slice(-(STREAM_CAP - 1)), event]);
  });

  const stream = events
    .filter((e) => (tag ? tagMatches(tag, e.tag) : true))
    .filter((e) => (target ? targetMatches(target, e.target) : true))
    .slice()
    .reverse();

  return (
    <section data-testid="bus-stream">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-medium">
          <Trans>Live</Trans>
        </h3>
        {(tag || target) && (
          <span className="text-xs text-muted-foreground">
            <Trans>filtered to {tag ?? target}</Trans>
          </span>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="gap-1"
          onClick={() => setPaused((p) => !p)}
          data-testid="bus-pause"
        >
          {paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
          {paused ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
        </Button>
      </div>
      <div className="max-h-72 overflow-auto rounded border border-border font-mono text-[11px]">
        {stream.length === 0 ? (
          <p className="p-3 font-sans text-xs text-muted-foreground">
            <Trans>Nothing yet. Only some event families reach the app; the counts above cover every event.</Trans>
          </p>
        ) : (
          stream.map((e) => (
            <div
              key={e.id}
              className="grid grid-cols-[6rem_minmax(0,12rem)_minmax(0,1fr)] gap-2 border-t border-border px-2 py-1 first:border-t-0"
            >
              <span className="text-muted-foreground">{new Date(e.timestamp).toLocaleTimeString()}</span>
              <span className="truncate">{e.tag}</span>
              <span className="truncate text-muted-foreground">{e.target}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
