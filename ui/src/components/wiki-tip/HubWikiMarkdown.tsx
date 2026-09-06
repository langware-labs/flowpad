import { useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { getRaw } from '@sdk/client';
import { MarkdownView } from '@src/components/markdown-view';

/** Fetch the page body from the hub's legacy wiki route. The hub returns the
 *  raw `{type, id, asset_ref, content} | null` shape — NO ApiResponse envelope
 *  (hub code is not ours to change), so it is read through `getRaw`, which
 *  wraps the bare body for the client's unwrapping interceptor. The client
 *  carries the hub base URL and auth; no URL is built here. */
async function fetchHubWikiContent(name: string): Promise<string | null> {
  const body = await getRaw<{ content?: unknown } | null>('/api/v1/wiki/resolve', { params: { name } });
  const content = body && typeof body === 'object' ? body.content : null;
  return typeof content === 'string' ? content : null;
}

type State = { kind: 'loading' } | { kind: 'ready'; content: string } | { kind: 'missing' } | { kind: 'error'; message: string };

/**
 * The wiki modal's body on the HUB runtime. The hub has NO `wiki` graph entity
 * (both graph resolve paths 422), so `WikiResolveView` cannot render there; its
 * one wiki surface is the legacy resolve route, which serves the shipped doc's
 * markdown directly. Rendered by {@link WikiModalRoot} in place of the view.
 */
export function HubWikiMarkdown({ name }: { name: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchHubWikiContent(name)
      .then((content) => {
        if (cancelled) return;
        setState(content ? { kind: 'ready', content } : { kind: 'missing' });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (state.kind === 'ready') return <MarkdownView value={state.content} />;
  return (
    <p className="p-4 text-sm text-muted-foreground" data-testid="hub-wiki-status">
      {state.kind === 'loading' ? (
        <Trans>Loading…</Trans>
      ) : state.kind === 'missing' ? (
        <Trans>Wiki page not found on this hub.</Trans>
      ) : (
        state.message
      )}
    </p>
  );
}
