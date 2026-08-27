import { t } from '@lingui/core/macro';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useFS } from '@src/hooks/useFS';

/**
 * Render a local HTML file — a chart, a report, a small static site — in an
 * iframe pointed at the file's own served url (`fs/serve`).
 *
 * **The url is the feature.** This pane used to read the file and hand the
 * markup to the frame as `srcDoc`. A `srcdoc` document has no url of its own,
 * so the browser resolved its relative references against the PARENT document,
 * which is the app's dock route: `<a href="page2.html">` became
 * `/dock/shell/page2.html`, a path holding no file — a blank pane locally, and
 * the cookie-gate's Forbidden page on a gated instance. The same missing
 * address broke sibling images, stylesheets, `#anchors`, `srcset`, css
 * `url(...)`, script-driven navigation and nested frames: one cause wearing a
 * dozen costumes, each of which had to be patched separately.
 *
 * Serving ends the whole class at once, because `fs/serve`'s url ends in the
 * file's own path — so `page2.html` beside `index.html` resolves to that file
 * and nothing has to be intercepted, rewritten or inlined. The click
 * interceptor, the `previewLinkTarget` resolver and the data:-uri asset
 * inliner (with its 2MB/8MB ceilings) are gone with it.
 *
 * **What the sandbox still withholds, deliberately.** `allow-same-origin` is
 * NOT granted. The served url sits on the app's own origin, so granting it
 * would let an agent-written page call the API with the user's session and
 * reach `parent.document` — the app's own UI. Everything that does not need an
 * origin is granted instead (forms, modals, popups, downloads). The cost is
 * `localStorage` and `fetch` of the page's own data files, both of which need a
 * real origin; buying them back means serving from a SEPARATE origin, which is
 * its own piece of work (a distinct host cannot carry the `__Host-` gate
 * cookie). The gate is why this url must stay on the app's host: same host,
 * different path, so the cookie rides along even from a sandboxed frame.
 */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

export function HtmlPreview({ path }: { path: string }) {
  const { computeNode } = useAgentContext();
  const fs = useFS(computeNode?.typeId);

  // The revision the FS store bumps on every write to this path. Carrying it in
  // the query string is what makes an agent's edit show up: the response is
  // `no-store`, but the iframe would keep the document it already has until its
  // src actually changes.
  const revision = fs?.revision(path) ?? 0;
  const src = computeNode?.typeId && fs ? `${fs.getServeUrl(path)}?r=${revision}` : null;

  if (!src) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t`Loading preview…`}</div>
    );
  }

  return (
    <iframe
      title={t`HTML preview`}
      sandbox={PREVIEW_SANDBOX}
      src={src}
      className="h-full w-full border-0 bg-white"
      data-testid="html-preview"
    />
  );
}

export default HtmlPreview;
