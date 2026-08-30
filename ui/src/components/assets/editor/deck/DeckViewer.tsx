import { t } from '@lingui/core/macro';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, ExternalLink, Presentation } from 'lucide-react';
import { FSRef, type Deck } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { AssetCollisionBadge } from '../AssetCollisionUI';

/**
 * DeckViewer — the presenter surface for a generated `deck` entity.
 *
 * A deck's `asset_ref` is the folder; the assembled, self-contained Reveal HTML
 * lives at `<folder>/<html_file>`. This viewer reads that file and frames it as a
 * presentation:
 *
 * - A **dark full-pane frame** with the deck in a **16:9 iframe** centered in it.
 *   Giving Reveal a genuinely 16:9 container means it fills the frame with no
 *   letterbox — so the white-gutter bug never shows in-app, even for decks built
 *   before the theme.css fix. The dark margins are the frame.
 * - The iframe is `sandbox="allow-scripts"` **`allow="fullscreen"`** (mirrors
 *   `persistent-iframe.tsx`) so Reveal's own F key works; a host Fullscreen button
 *   fullscreens the dark deck area (black bars + centered 16:9 deck).
 * - Reveal's built-in controls (arrows/keys/overview) handle slide nav inside.
 * - Read/present-only (no editing), matching DeckTemplateViewer.
 */

interface DeckViewerProps {
  fsRef: FSRef;
  deck?: Deck;
}

export function DeckViewer({ fsRef, deck }: DeckViewerProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read from deck.json on disk (the DB entity does not project these — the
  // metadata-derived fields only populate via from_fs_ref; the viewer computes
  // them itself, like DeckTemplateViewer counts its layouts).
  const [numSlides, setNumSlides] = useState<number | null>(null);
  const [templateVpath, setTemplateVpath] = useState<string | null>(null);
  const deckAreaRef = useRef<HTMLDivElement>(null);
  const { navigation } = useDockNavigation();

  // Re-read when the deck is rebuilt (updated_date advances on reindex).
  const reloadKey = entityReloadKey((deck as { updated_date?: unknown } | undefined)?.updated_date);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Resolve the html ref (recorded html_file, else the single *.html), then
        // read it and deck.json in parallel — the two reads are independent.
        let ref: FSRef | null = deck?.html_file ? fsRef.child(deck.html_file) : null;
        if (!ref) {
          const files = await fsRef.ls();
          ref =
            files.find((f) => f.path.toLowerCase().endsWith('.html') && !f.path.toLowerCase().endsWith('.mcp.html')) ??
            null;
        }
        if (!ref) throw new Error('No deck HTML in this folder.');
        // deck.json is nice-to-have (slide count + provenance) — a missing/invalid
        // one leaves those unset, never fails the deck itself.
        const [text, manifest] = await Promise.all([
          ref.read(),
          fsRef
            .child('deck.json')
            .read()
            .then(JSON.parse)
            .catch(() => null),
        ]);
        if (cancelled) return;
        setHtml(text);
        setNumSlides(Array.isArray(manifest?.slides) ? manifest.slides.length : null);
        if (manifest && typeof manifest.template === 'string' && manifest.template) {
          setTemplateVpath(fsRef.resolve(manifest.template).vpath);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // reloadKey re-reads on rebuild/reindex.
  }, [fsRef, deck?.html_file, reloadKey]);

  const title = deck?.name || deck?.title || 'Deck';

  const openInNewTab = () => {
    if (!html) return;
    // The portable, self-contained file — opened in a real tab it is unrestricted
    // (fullscreen, presenter view, keyboard all work).
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
  };

  // Provenance nav uses the template FOLDER resolved from deck.json — the deck
  // entity's `template_ref` id isn't projected on DB load, so the folder (via
  // vfs path) is the reliable single source.
  const openTemplate = () => {
    if (!templateVpath) return;
    navigation.openDock(AssetDocPointer.forVfs(AssetEditor.DECK_TEMPLATE, templateVpath).toDockPointer());
  };

  const srcDoc = useMemo(() => html ?? '', [html]);

  if (error) {
    return <div className="p-6 text-sm text-destructive">Failed to load deck: {error}</div>;
  }

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="truncate text-sm font-medium text-neutral-100">{title}</span>
        <AssetCollisionBadge />
        {numSlides && numSlides > 0 ? (
          <span className="shrink-0 text-xs text-neutral-500">{numSlides} slides</span>
        ) : null}
        <div className="ms-auto flex items-center gap-1">
          {templateVpath ? (
            <button
              type="button"
              onClick={openTemplate}
              title={t`Open the source template`}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
            >
              <Presentation className="h-3.5 w-3.5" />
              <span>Template</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={openInNewTab}
            title={t`Open in a new browser tab`}
            className="rounded p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void deckAreaRef.current?.requestFullscreen?.()}
            title={t`Fullscreen`}
            className="rounded p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Dark deck area — fullscreen target. The 16:9 box is centered here so
          Reveal always sees a 16:9 container (fills it, no white letterbox). */}
      <div ref={deckAreaRef} className="flex min-h-0 flex-1 items-center justify-center bg-black p-2">
        {html === null ? (
          <div className="text-sm text-neutral-500">Loading deck…</div>
        ) : (
          <div className="aspect-video max-h-full max-w-full" style={{ width: '100%' }}>
            <iframe
              title={`${title} deck`}
              sandbox="allow-scripts"
              allow="fullscreen"
              srcDoc={srcDoc}
              className="h-full w-full border-0 bg-black"
              data-testid="deck-frame"
            />
          </div>
        )}
      </div>
    </div>
  );
}
