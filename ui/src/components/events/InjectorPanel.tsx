/**
 * Put a real event on the bus by hand.
 *
 * Goes through the BACKEND (`POST /debug/emit_tag`) rather than a local
 * `EventBus.emit`, and that distinction is the whole point: an app-tier emit
 * reaches nothing on the server, so no rule, flow subscription or backend
 * handler would see it. Injecting server-side exercises the real path, and the
 * event comes back through the feed like any other.
 *
 * The tag list is seeded from `observed_tags` — tags actually seen on this bus —
 * because guessing a tag name is the main reason a hand-fired event goes
 * nowhere.
 */
import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import apiClient from '@sdk/client';
import { tagPatternProblem } from '@sdk/tags/grammar';
import type { FlowEvent } from '@sdk/tags/EventBus';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';

interface ObservedResponse {
  observed: Record<string, { count: number; last_target?: string }>;
  count: number;
}

export function InjectorPanel() {
  const { t } = useLingui();
  const [tag, setTag] = useState('');
  const [target, setTarget] = useState('');
  const [body, setBody] = useState('{}');
  const [observed, setObserved] = useState<Record<string, { count: number; last_target?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [bad, setBad] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await apiClient.get('/debug/observed_tags')) as ObservedResponse | null;
        if (alive && data) setObserved(data.observed ?? {});
      } catch {
        // Suggestions are a convenience; the tag field still accepts anything.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const suggestions = useMemo(
    () =>
      Object.entries(observed)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 40),
    [observed],
  );

  const problem = tag ? tagPatternProblem(tag) : null;

  const fire = async () => {
    setBusy(true);
    setNote(null);
    setBad(false);
    try {
      let data: unknown = {};
      if (body.trim()) data = JSON.parse(body);
      const event = (await apiClient.post('/debug/emit_tag', { tag, target, data })) as
        | FlowEvent
        | null;
      setNote(
        event
          ? t`Emitted ${event.id} — watch for it in the feed.`
          : t`Emitted, but nothing on the backend is subscribed to that tag.`,
      );
    } catch (e) {
      setBad(true);
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-t p-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Trans>Inject an event</Trans>
      </h3>
      <div className="flex flex-col gap-2">
        <Input
          list="events-observed-tags"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder={t`tag e.g. entity.created`}
          className={cn('h-7 font-mono text-xs', problem && 'border-destructive')}
        />
        <datalist id="events-observed-tags">
          {suggestions.map(([name, stat]) => (
            <option key={name} value={name}>
              {stat.count}×
            </option>
          ))}
        </datalist>
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={t`target e.g. usage_report:abc`}
          className="h-7 font-mono text-xs"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          spellCheck={false}
          className="w-full rounded border bg-background p-2 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy || !tag || !target || !!problem}
          onClick={() => void fire()}
        >
          {busy ? <Trans>Firing…</Trans> : <Trans>Fire onto the bus</Trans>}
        </Button>
        {problem && <p className="text-[10px] text-destructive">{problem}</p>}
        {note && (
          <p className={cn('text-[10px]', bad ? 'text-destructive' : 'text-muted-foreground')}>
            {note}
          </p>
        )}
      </div>
    </section>
  );
}
