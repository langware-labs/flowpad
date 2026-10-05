/**
 * The event bus — for experts. Start from an event type, see who listens and
 * what they do, then drop to the raw stream; test a pattern without saving a
 * rule; put an event on the bus by hand. Built-in rules are fully visible here.
 *
 * Everything goes through the TS SDK (`Trigger.busMap`, `Trigger.matchPattern`,
 * `recentBusEvents`, `emitBusEvent`); the live half is `useOnTag`.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import {
  emitBusEvent,
  recentBusEvents,
  tagMatches,
  targetMatches,
  Trigger,
  type BusEventType,
  type PatternMatch,
} from '@sdk';
import { useOnTag } from '@sdk/react/hooks';
import type { FlowEvent } from '@sdk/tags/EventBus';
import { ArrowRight, Pause, Play, Plus, Search, Send, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { useBusMap } from '@src/hooks/automations/useAutomations';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useAutomationWords } from './automation-words';
import type { AutomationsRoute } from './automations-pointer';

/** How many events the live stream keeps in view. */
const STREAM_CAP = 200;

export function BusView({ route }: { route: AutomationsRoute }) {
  const { t } = useLingui();
  const words = useAutomationWords();
  const { navigation } = useDockNavigation();
  const { data: map, error } = useBusMap();
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const go = (patch: Partial<AutomationsRoute>) =>
    navigation.openDock(DockPointer.forAutomations({ ...route, place: 'bus', ...patch }));

  // Seed from the backend ring (the bus keeps no history), then follow live.
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

  const types = useMemo(
    () =>
      (map?.event_types ?? [])
        .filter((e) => !e.family)
        .filter((e) => !query || `${e.name} ${e.title}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => b.listeners.length - a.listeners.length || b.count - a.count || a.name.localeCompare(b.name)),
    [map, query],
  );
  const selected: BusEventType | undefined = map?.event_types.find((e) => e.name === route.tag);
  const stream = events
    .filter((e) => (route.tag ? tagMatches(route.tag, e.tag) : true))
    .filter((e) => (route.target ? targetMatches(route.target, e.target) : true))
    .slice()
    .reverse();

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="automations-bus">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <h2 className="text-lg font-semibold">
          <Trans>Event bus</Trans>
        </h2>
        <span className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">
          <Trans>Advanced</Trans>
        </span>
        <p className="w-full text-sm text-muted-foreground">
          <Trans>Everything Flowpad announces, who listens, and what they do. Counts are since the app started.</Trans>
        </p>
      </header>
      {error && (
        <p className="m-4 rounded border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm">
          {errorMessage(error, t`Could not load the bus`)}
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(22rem,1fr)_2fr]">
        <div className="flex min-h-0 flex-col border-r border-border">
          <div className="relative p-3">
            <Search className="absolute left-5 top-5 size-4 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t`Find an event`}
              className="pl-8"
              data-testid="bus-search"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto" data-testid="bus-catalog">
            {/* Column headings: the two numbers mean nothing without them. */}
            <div
              className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_3.5rem_5.5rem] items-end gap-2 border-b border-border bg-background px-3 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              data-testid="bus-catalog-headings"
            >
              <span>
                <Trans>Event</Trans>
              </span>
              <span className="text-right" title={t`Times this event happened since Flowpad started`}>
                <Trans>Seen</Trans>
              </span>
              <span className="text-right" title={t`Automations that run when this event happens`}>
                <Trans>Automations</Trans>
              </span>
            </div>
            {types.map((e) => (
              <button
                key={e.name}
                type="button"
                data-testid={`bus-type-${e.name}`}
                onClick={() => go({ tag: route.tag === e.name ? null : e.name })}
                className={cn(
                  'grid w-full grid-cols-[minmax(0,1fr)_3.5rem_5.5rem] items-center gap-2 border-t border-border px-3 py-1.5 text-left text-xs hover:bg-accent/50',
                  route.tag === e.name && 'bg-accent',
                )}
              >
                <span className="min-w-0">
                  <code className="block truncate font-mono">{e.name}</code>
                  {e.title && <span className="block truncate text-muted-foreground">{e.title}</span>}
                </span>
                <span
                  className="text-right tabular-nums text-muted-foreground"
                  title={
                    e.pattern_only
                      ? t`No event like this has happened yet`
                      : t`Seen ${e.count} times since Flowpad started`
                  }
                >
                  {e.pattern_only || e.count === 0 ? t`never` : `${e.count}×`}
                </span>
                <span className="flex justify-end" title={t`Automations that run when this event happens`}>
                  {e.listeners.length > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 tabular-nums text-foreground">
                      <Zap className="size-3" aria-hidden />
                      {e.listeners.length}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-5 overflow-auto p-5">
          {selected ? (
            <section data-testid="bus-flow">
              <h3 className="mb-1 text-sm font-medium">
                {selected.title || selected.name}{' '}
                <code className="ml-1 font-mono text-xs text-muted-foreground">{selected.name}</code>
              </h3>
              {selected.description && <p className="mb-3 text-xs text-muted-foreground">{selected.description}</p>}
              {selected.listeners.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>Nothing listens for this yet.</Trans>
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {selected.listeners.map((l) => (
                    <div
                      key={l.id}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-xs"
                    >
                      <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                      <button
                        type="button"
                        onClick={() => navigation.openDock(DockPointer.forAutomations({ trigger: l.id }))}
                        className={cn(
                          'truncate rounded border border-border px-2 py-1 text-left hover:bg-accent/50',
                          (!l.enabled || !l.active) && 'opacity-60',
                        )}
                        data-testid={`bus-listener-${l.id}`}
                      >
                        {l.name}
                        {!l.active ? (
                          <span className="ml-1 text-muted-foreground">
                            · <Trans>inactive copy</Trans>
                          </span>
                        ) : !l.enabled ? (
                          <span className="ml-1 text-muted-foreground">
                            · <Trans>off</Trans>
                          </span>
                        ) : l.group === 'builtin' ? (
                          <span className="ml-1 text-muted-foreground">
                            · <Trans>built-in</Trans>
                          </span>
                        ) : null}
                      </button>
                      <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="truncate rounded bg-muted px-2 py-1">{l.then.map(words.then).join(', ')}</span>
                    </div>
                  ))}
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                className="mt-3 gap-1.5"
                data-testid="bus-make-automation"
                onClick={() =>
                  navigation.openDock(DockPointer.forAutomations({ creating: 'event', tag: selected.name }))
                }
              >
                <Plus className="size-3.5" aria-hidden />
                <Trans>New automation on this event</Trans>
              </Button>
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">
              <Trans>Pick an event to see who listens and what they do.</Trans>
            </p>
          )}

          <section data-testid="bus-stream">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium">
                <Trans>Live</Trans>
              </h3>
              {(route.tag || route.target) && (
                <span className="text-xs text-muted-foreground">
                  <Trans>filtered to {route.tag ?? route.target}</Trans>
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
                  <Trans>
                    Nothing yet. Only some event families reach the app; the counts above cover every event.
                  </Trans>
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

          <PatternSandbox defaultPattern={route.tag ?? ''} />
          <SendEvent defaultTag={route.tag ?? ''} />
        </div>
      </div>
    </div>
  );
}

function PatternSandbox({ defaultPattern }: { defaultPattern: string }) {
  const { t } = useLingui();
  const [pattern, setPattern] = useState(defaultPattern || 'task.*');
  const [targetFilter, setTargetFilter] = useState('');
  const [tag, setTag] = useState('task.assigned');
  const [target, setTarget] = useState('task:123');
  const [result, setResult] = useState<PatternMatch | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const test = async () => {
    try {
      setProblem(null);
      setResult(await Trigger.matchPattern(pattern, { tag, target }, targetFilter || null));
    } catch (e) {
      setProblem(errorMessage(e, t`Could not test it`));
    }
  };
  const part = (ok: boolean, label: string) => (
    <span className={cn('rounded border px-1.5', ok ? 'border-emerald-500/50' : 'border-red-500/60 bg-red-500/10')}>
      {label} {ok ? '✓' : '✗'}
    </span>
  );
  return (
    <section className="rounded-md border border-border p-3" data-testid="bus-sandbox">
      <h3 className="mb-2 text-sm font-medium">
        <Trans>Pattern sandbox</Trans>
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">
        <Trans>Would a pattern catch this event? Nothing is saved.</Trans>
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="task.*"
          className="font-mono text-xs"
          aria-label={t`Pattern`}
          data-testid="bus-sandbox-pattern"
        />
        <Input
          value={targetFilter}
          onChange={(e) => setTargetFilter(e.target.value)}
          placeholder={t`Only about (optional)`}
          className="font-mono text-xs"
          aria-label={t`Only about`}
        />
        <Input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="task.assigned"
          className="font-mono text-xs"
          aria-label={t`Event`}
          data-testid="bus-sandbox-tag"
        />
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="task:123"
          className="font-mono text-xs"
          aria-label={t`Subject`}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <Button size="sm" variant="outline" onClick={() => void test()} data-testid="bus-sandbox-test">
          <Trans>Test</Trans>
        </Button>
        {result && (
          <span
            data-testid="bus-sandbox-result"
            data-matches={result.matches}
            className="flex flex-wrap items-center gap-1.5"
          >
            <strong>{result.matches ? <Trans>Matches</Trans> : <Trans>No match</Trans>}</strong>
            {part(result.parts.tag, t`event`)}
            {part(result.parts.target, t`subject`)}
            {result.problem && <span>{result.problem}</span>}
          </span>
        )}
        {problem && <span className="rounded border border-red-500/60 bg-red-500/10 px-1.5">{problem}</span>}
      </div>
    </section>
  );
}

function SendEvent({ defaultTag }: { defaultTag: string }) {
  const { t } = useLingui();
  const [tag, setTag] = useState(defaultTag);
  const [target, setTarget] = useState('test:manual');
  const [body, setBody] = useState('{}');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    try {
      const data = body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {};
      const event = await emitBusEvent(tag, target, data);
      setNote({ ok: true, text: event ? t`Sent. Watch for it above.` : t`Sent, but nothing listens for that event.` });
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e, t`Could not send it`) });
    }
  };
  return (
    <section className="rounded-md border border-border p-3" data-testid="bus-send">
      <h3 className="mb-2 text-sm font-medium">
        <Trans>Send a test event</Trans>
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">
        <Trans>Puts a real event on the bus. Every automation listening for it runs for real.</Trans>
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="app.ready"
          className="font-mono text-xs"
          aria-label={t`Event`}
          data-testid="bus-send-tag"
        />
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="font-mono text-xs"
          aria-label={t`Subject`}
          data-testid="bus-send-target"
        />
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        className="mt-2 font-mono text-xs"
        aria-label={t`Data (JSON)`}
      />
      <div className="mt-2 flex items-center gap-2 text-xs">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={!tag.trim()}
          onClick={() => void send()}
          data-testid="bus-send-go"
        >
          <Send className="size-3.5" aria-hidden />
          <Trans>Send</Trans>
        </Button>
        {note && (
          <span
            className={cn(
              'rounded border px-1.5',
              note.ok ? 'border-emerald-500/50' : 'border-red-500/60 bg-red-500/10',
            )}
          >
            {note.text}
          </span>
        )}
      </div>
    </section>
  );
}
