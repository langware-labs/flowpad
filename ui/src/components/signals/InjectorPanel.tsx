/**
 * The event injector — put a real event on the bus by hand.
 *
 * Goes through the backend (`POST /debug/emit_tag`) rather than a local
 * `EventBus.emit`, and that distinction is the whole point: a locally emitted
 * app-tier event reaches nothing on the server, so no trigger, flow
 * subscription or backend handler would see it. Injecting server-side exercises
 * the real path, and the event comes back to this feed the same way any other
 * event does.
 *
 * The tag list is seeded from `observed_tags` — tags actually seen on this bus —
 * because guessing a tag name is the main reason a hand-fired event goes
 * nowhere.
 */
import { useEffect, useMemo, useState } from 'react';
import apiClient from '@sdk/client';
import { tagPatternProblem } from '@sdk/tags/grammar';
import type { FlowEvent } from '@sdk/tags/EventBus';

interface ObservedResponse {
  observed: Record<string, { count: number; last_target?: string }>;
  count: number;
}

export function InjectorPanel() {
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
        .slice(0, 40)
        .map(([name, stat]) => ({ name, target: stat.last_target ?? '' })),
    [observed],
  );

  const dataError = useMemo(() => {
    if (!body.trim()) return null;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'data must be a JSON object';
      }
      return null;
    } catch {
      return 'not valid JSON';
    }
  }, [body]);

  // Say WHY the button is dead rather than just greying it out. The fields are
  // placeholder-heavy, and a placeholder reads exactly like a filled value at a
  // glance — which is how you end up clicking a disabled button repeatedly.
  const blocker = !tag.trim()
    ? 'enter a tag'
    // The bus has a grammar and a validator that explains itself — use it
    // rather than letting a malformed tag fail silently at emit.
    : (tagPatternProblem(tag.trim()) ?? (!target.trim() ? 'enter a target' : dataError));
  const canFire = !blocker && !busy;

  async function fire() {
    if (!canFire) return;
    setBusy(true);
    setNote(null);
    setBad(false);
    try {
      const event = (await apiClient.post('/debug/emit_tag', {
        tag: tag.trim(),
        target: target.trim(),
        data: body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {},
      })) as FlowEvent | null;
      // A null envelope is a real answer, not a failure: the bus builds one
      // lazily and returns nothing when no subscriber matched. Nothing to append
      // to the feed by hand either — an injected event rides the bus back like
      // any other and arrives through the same subscription.
      setNote(event ? 'fired — watch the feed' : 'fired, but nothing is subscribed to that tag');
    } catch (e) {
      setBad(true);
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel injector">
      <h2>Inject an event</h2>
      <label>
        <span>tag</span>
        <input
          value={tag}
          list="signals-observed-tags"
          placeholder="ingest.hackernews.sync.completed"
          onChange={(e) => {
            const next = e.target.value;
            setTag(next);
            // Offer the target this tag was last seen with — it is almost
            // always the one you want, and a wrong target silently matches
            // nothing.
            const seen = observed[next]?.last_target;
            if (seen && !target) setTarget(seen);
          }}
        />
      </label>
      <datalist id="signals-observed-tags">
        {suggestions.map((s) => (
          <option key={s.name} value={s.name} />
        ))}
      </datalist>
      <label>
        <span>target</span>
        <input
          value={target}
          placeholder="data_source:<id>"
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <label>
        <span>data</span>
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
      </label>
      <button className="btn primary" disabled={!canFire} onClick={() => void fire()}>
        {busy ? 'firing…' : 'Fire onto the bus'}
      </button>
      {blocker && !busy && <p className="warn">{blocker}</p>}
      {note && <p className={bad ? 'warn' : 'ok'}>{note}</p>}
    </section>
  );
}
