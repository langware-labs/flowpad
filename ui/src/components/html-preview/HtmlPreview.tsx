import { t } from '@lingui/core/macro';
import { FSRef } from '@sdk';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useFS } from '@src/hooks/useFS';
import { useDockNavigation } from '@src/navigation';

/**
 * Render a local self-contained HTML file (a chart, a diagram, a one-file
 * artifact) in a sandboxed iframe. The file is read through the FSRef channel
 * (never a hand-built backend URL) and injected as `srcDoc`; `allow-scripts`
 * without `allow-same-origin` keeps agent-generated markup isolated from the
 * app's origin.
 */
/**
 * The href a link in the preview points at, as an ABSOLUTE MACHINE PATH beside
 * the previewed file — or null when the link is not ours to route.
 *
 * A `srcdoc` document has no URL of its own, so the browser resolves its
 * relative URLs against the PARENT document, which is the app's own dock route.
 * `<a href="page2.html">` in a generated two-page site therefore resolved to
 * `/dock/shell/page2.html`: a path holding no such file, which a gated instance
 * answers with the cookie-gate's Forbidden page and an ungated one answers with
 * nothing. The site was never wrong; the frame's base was.
 *
 * Resolution happens HERE, against the file we are showing, rather than by
 * handing the guest a `<base>`. A `<base>` would only redirect the guest's own
 * fetches, and the guest is `allow-scripts` with no `allow-same-origin` — an
 * opaque origin that carries no credentials, so on a gated box its fetch of the
 * sibling would be refused exactly as before. The parent has both the identity
 * and the file's location; the guest has neither.
 *
 * Returns null for in-page anchors (`#top`, which the guest handles itself) and
 * for anything carrying a scheme (`https:`, `mailto:`) — those are not files
 * next to this one.
 */
export function previewLinkTarget(filePath: string, href: string): string | null {
  if (!href || href.startsWith('#')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null;
  const dir = filePath.replace(/[^/]*$/, '');
  try {
    const resolved = new URL(href, `preview://local${encodeURI(dir)}`);
    if (resolved.protocol !== 'preview:') return null;
    return decodeURIComponent(resolved.pathname);
  } catch {
    return null;
  }
}

/**
 * Injected ahead of the file's own markup, into the COPY handed to the iframe —
 * never into the file. Whatever the user publishes, commits or downloads is the
 * bytes the agent wrote and nothing else.
 *
 * It stops the guest navigating and tells the parent where it wanted to go; the
 * parent then opens that file through the router like any other "open this
 * file" click, so the address bar stays the source of truth.
 */
/**
 * Per-asset and whole-page ceilings on what we inline.
 *
 * A `data:` URI is base64, so it costs about a third more than the file, and it
 * rides inside the page string on every render instead of being fetched and
 * cached once. A logo or a stylesheet is free at that price; a video is not.
 * Anything over the line is LEFT ALONE and named on screen — a broken image the
 * user cannot explain is worse than a missing one we account for.
 */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Relative `src=` / `href=` values — the ones that resolve against the parent. */
const ASSET_REF = /(src|href)="(?![a-zA-Z][a-zA-Z0-9+.-]*:|#|\/)([^"]+)"/g;

export interface InlinedHtml {
  html: string;
  /** Refs left as-is, so the pane can say which files it could not carry. */
  skipped: string[];
}

/**
 * Carry the page's own images, stylesheets and scripts INSIDE the copy we show.
 *
 * Same cause as the link bug and a different remedy, because there is no click
 * to intercept: the browser fetches a resource itself, and a `srcdoc` frame
 * resolves `src="pic.png"` against the parent — `/dock/shell/pic.png`, an app
 * route holding no file. Nor can we hand it a working URL: `allow-scripts`
 * without `allow-same-origin` is an opaque origin that sends no credentials, so
 * the fs `download` route would refuse it exactly as the gate refused the link.
 *
 * So the PARENT reads the bytes — it has the session — and the bytes travel in
 * the markup. The URL comes from `fs.getDownloadUrl`, never built here, and the
 * response is raw bytes rather than the `{status,data}` envelope, which is why
 * this is a plain same-origin `fetch` of an SDK-issued URL and not `apiClient`.
 *
 * Reads only. The file on disk is never rewritten, so what the user publishes,
 * commits or downloads stays the markup the agent wrote, pointing at its own
 * sibling files.
 */
export async function inlineAssets(
  html: string,
  filePath: string,
  fs: { getDownloadUrl?: (p: string) => string } | null | undefined,
): Promise<InlinedHtml> {
  if (!fs?.getDownloadUrl) return { html, skipped: [] };

  const refs = [...new Set([...html.matchAll(ASSET_REF)].map((m) => m[2]))];
  const skipped: string[] = [];
  const inlined = new Map<string, string>();
  let budget = MAX_TOTAL_BYTES;

  await Promise.all(
    refs.map(async (href) => {
      const target = previewLinkTarget(filePath, href);
      if (!target) return;
      try {
        const response = await fetch(fs.getDownloadUrl!(target));
        if (!response.ok) {
          skipped.push(href);
          return;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_ASSET_BYTES || bytes.byteLength > budget) {
          skipped.push(href);
          return;
        }
        budget -= bytes.byteLength;
        let binary = '';
        bytes.forEach((b) => (binary += String.fromCharCode(b)));
        const mime = response.headers.get('content-type') ?? 'application/octet-stream';
        inlined.set(href, `data:${mime};base64,${btoa(binary)}`);
      } catch {
        skipped.push(href);
      }
    }),
  );

  return {
    html: html.replace(ASSET_REF, (whole, attr: string, href: string) =>
      inlined.has(href) ? `${attr}="${inlined.get(href)!}"` : whole,
    ),
    skipped,
  };
}

const LINK_INTERCEPTOR = `<script>
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  var href = a.getAttribute('href');
  if (!href || href.charAt(0) === '#') return;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return;
  e.preventDefault();
  parent.postMessage({ type: 'flowpad:preview-link', href: href }, '*');
}, true);
</script>`;

export function HtmlPreview({ path }: { path: string }) {
  const { computeNode } = useAgentContext();
  const { navigation } = useDockNavigation();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const nodeKey = computeNode?.typeId?.toString() ?? null;
  const fs = useFS(computeNode?.typeId);
  const revision = fs?.revision(path) ?? 0;
  useEffect(() => {
    if (!nodeKey || !computeNode?.typeId) return;
    let cancelled = false;
    setHtml(null);
    setSkipped([]);
    setError(null);
    new FSRef(path.replace(/^\//, ''), computeNode.typeId)
      .read()
      .then(async (text) => {
        const carried = await inlineAssets(text, path, fs);
        if (cancelled) return;
        setHtml(carried.html);
        setSkipped(carried.skipped);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nodeKey, revision]);

  // Only this frame's messages, and only ours. A page in the preview can post
  // anything it likes; matching on the source window keeps another frame from
  // steering the dock.
  useEffect(() => {
    const typeId = computeNode?.typeId;
    if (!typeId) return;
    const onMessage = (event: MessageEvent) => {
      if (frameRef.current && event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { type?: string; href?: string } | null;
      if (!data || data.type !== 'flowpad:preview-link' || typeof data.href !== 'string') return;
      const target = previewLinkTarget(path, data.href);
      if (target) navigation.openMachinePath(target, typeId);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [path, computeNode?.typeId, navigation]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading preview…
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      {skipped.length > 0 && (
        <div
          className="absolute inset-x-0 top-0 z-10 bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-400"
          data-testid="html-preview-skipped"
        >
          {t`Too large to preview:`} {skipped.join(', ')}
        </div>
      )}
      <iframe
        ref={frameRef}
        title={t`HTML preview`}
        sandbox="allow-scripts"
        srcDoc={LINK_INTERCEPTOR + html}
        className="h-full w-full border-0 bg-white"
        data-testid="html-preview"
      />
    </div>
  );
}

export default HtmlPreview;
