import { useEffect, useMemo, useState } from 'react';
import { FSRef, type DeckTemplate } from '@sdk';
import { Dialog, DialogContent } from '@src/components/ui/dialog';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { AssetCollisionBadge } from '../AssetCollisionUI';

/**
 * DeckTemplateViewer — a gallery of a deck template's layouts.
 *
 * A `deck_template` entity's `asset_ref` is the template FOLDER. This viewer
 * lists `layouts/*.html`, reads each fragment plus the template's
 * `common/tokens.css` + `common/theme.css`, and renders each layout as a live,
 * scaled, sandboxed iframe card (the HtmlPreview pattern generalized to a
 * fragment + injected stylesheets). Clicking a card opens it full-size.
 *
 * Slide geometry is the deck's authoring canvas: 1280×720 (16:9). Cards render
 * at full size and CSS-scale down inside a clipped box so typography/spacing
 * read faithfully.
 *
 * NOTE (v1): layout media slots reference relative `media/...` paths that a
 * sandboxed `srcDoc` iframe (no base URL) cannot resolve, so media shows as its
 * placeholder box here. That's fine for reviewing the design system; full media
 * inlining (reusing the skill's build_deck.py base64 step) is a later nicety.
 */

const SLIDE_W = 1280;
const SLIDE_H = 720;
const CARD_W = 320; // thumbnail width; height derives from the 16:9 ratio
const CARD_SCALE = CARD_W / SLIDE_W;

interface LayoutEntry {
  name: string; // file stem, e.g. "cover-centered"
  pageType: string; // from data-page-type, e.g. "cover"
  html: string; // the layout fragment
}

interface DeckTemplateViewerProps {
  fsRef: FSRef;
  deckTemplate?: DeckTemplate;
}

/** Wrap a layout fragment + the template's stylesheets into a standalone doc. */
function buildSrcDoc(fragment: string, tokensCss: string, themeCss: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${tokensCss}
${themeCss}
/* Viewer-only sizing: the deck runtime (Reveal) is absent here, so pin the
   authoring canvas and let the layout <section> fill it. */
html, body { margin: 0; padding: 0; background: var(--bg, #0b0d10); overflow: hidden; }
.reveal, .reveal .slides { width: ${SLIDE_W}px; height: ${SLIDE_H}px; }
.reveal .slides { position: relative; }
.reveal .slides > section {
  display: flex; width: ${SLIDE_W}px; height: ${SLIDE_H}px; box-sizing: border-box;
}
</style></head><body><div class="reveal"><div class="slides">${fragment}</div></div></body></html>`;
}

/** Parse the page type out of the fragment's root section. */
function pageTypeOf(html: string): string {
  return html.match(/data-page-type="([^"]+)"/)?.[1] ?? '';
}

function stemOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.html$/i, '');
}

export function DeckTemplateViewer({ fsRef, deckTemplate }: DeckTemplateViewerProps) {
  const [layouts, setLayouts] = useState<LayoutEntry[] | null>(null);
  const [tokensCss, setTokensCss] = useState('');
  const [themeCss, setThemeCss] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<LayoutEntry | null>(null);

  // Re-read the deck's layout/CSS files when the entity's `updated_date`
  // advances — a reindex (agent turn-end / invalidate re-parsed the folder)
  // bumps it, closing the `file change → reindex → refresh` loop for this
  // read-only viewer (no dirty state to guard). See useFSRefContent reloadKey.
  const reloadKey = entityReloadKey((deckTemplate as { updated_date?: unknown } | undefined)?.updated_date);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [tokens, theme, files] = await Promise.all([
          fsRef
            .child('common/tokens.css')
            .read()
            .catch(() => ''),
          fsRef
            .child('common/theme.css')
            .read()
            .catch(() => ''),
          fsRef.child('layouts').ls(),
        ]);
        const htmlFiles = files.filter((f) => f.path.toLowerCase().endsWith('.html'));
        const entries = await Promise.all(
          htmlFiles.map(async (f) => {
            const html = await f.read().catch(() => '');
            return { name: stemOf(f.path), pageType: pageTypeOf(html), html };
          }),
        );
        entries.sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) {
          setTokensCss(tokens);
          setThemeCss(theme);
          setLayouts(entries.filter((e) => e.html));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // reloadKey (entity updated_date) re-reads on out-of-band reindex.
     
  }, [fsRef, reloadKey]);

  const title = deckTemplate?.name || deckTemplate?.title || 'Deck template';

  if (error) {
    return <div className="p-6 text-sm text-destructive">Failed to load deck template: {error}</div>;
  }
  if (!layouts) {
    return <div className="p-6 text-sm text-muted-foreground">Loading layouts…</div>;
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          <AssetCollisionBadge />
        </div>
        <p className="text-sm text-muted-foreground">
          {layouts.length} layout{layouts.length === 1 ? '' : 's'}
          {deckTemplate?.description ? ` · ${deckTemplate.description}` : ''}
        </p>
      </div>

      {layouts.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground">
          This template has no layouts under <code>layouts/</code> yet.
        </div>
      ) : (
        <div className="flex flex-wrap gap-4 p-6">
          {layouts.map((layout) => (
            <LayoutCard
              key={layout.name}
              layout={layout}
              tokensCss={tokensCss}
              themeCss={themeCss}
              onOpen={() => setExpanded(layout)}
            />
          ))}
        </div>
      )}

      <Dialog open={!!expanded} onOpenChange={(o) => !o && setExpanded(null)}>
        <DialogContent className="max-w-[90vw] p-0" style={{ width: SLIDE_W * 0.7 + 2 }}>
          {expanded ? <LayoutFrame layout={expanded} tokensCss={tokensCss} themeCss={themeCss} scale={0.7} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LayoutCard({
  layout,
  tokensCss,
  themeCss,
  onOpen,
}: {
  layout: LayoutEntry;
  tokensCss: string;
  themeCss: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-start transition hover:border-primary"
      style={{ width: CARD_W }}
    >
      <LayoutFrame layout={layout} tokensCss={tokensCss} themeCss={themeCss} scale={CARD_SCALE} />
      <div className="flex items-baseline justify-between gap-2 px-3 py-2">
        <span className="truncate font-mono text-xs">{layout.name}</span>
        {layout.pageType ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {layout.pageType}
          </span>
        ) : null}
      </div>
    </button>
  );
}

/** A fixed 1280×720 sandboxed iframe scaled by `scale`, clipped to a 16:9 box. */
function LayoutFrame({
  layout,
  tokensCss,
  themeCss,
  scale,
}: {
  layout: LayoutEntry;
  tokensCss: string;
  themeCss: string;
  scale: number;
}) {
  const doc = useMemo(() => buildSrcDoc(layout.html, tokensCss, themeCss), [layout.html, tokensCss, themeCss]);
  return (
    <div className="relative overflow-hidden bg-black" style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
      <iframe
        title={`${layout.name} preview`}
        sandbox="allow-scripts"
        srcDoc={doc}
        className="border-0"
        style={{
          width: SLIDE_W,
          height: SLIDE_H,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
