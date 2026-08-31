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
 * **`allow-same-origin` is required, and withholding it does not work.** It was
 * withheld at first, on the reasoning that an opaque origin costs only
 * `localStorage` while keeping an agent-written page away from the API and from
 * `parent.document`. On a cookie-gated instance that reasoning is wrong, and it
 * fails in a way local testing cannot see (a desktop install is never gated, so
 * no cookie is ever needed there).
 *
 * A sandboxed frame WITHOUT `allow-same-origin` has an opaque origin, and an
 * opaque origin's *site for cookies* is null — so every request the document
 * itself makes counts as cross-site, and the `SameSite=Lax` `__Host-cookie-gate`
 * cookie is withheld from all of them. Same host or not: the host is not what
 * the browser is deciding on. The symptom is precise and was measured on e2b —
 * the frame's FIRST load is initiated by the parent, so it carries the cookie
 * and the page renders; then its own image fetch and its own link clicks arrive
 * cookie-less and the gate answers each with its Forbidden page.
 *
 * So the trade is not "isolation vs `localStorage`" but "isolation vs the page
 * loading at all". `PersistentIframe` (every `flow app serve` app) has run with
 * `allow-same-origin` on the same host through the same gate all along; this
 * matches it rather than inventing a weaker posture.
 *
 * What that costs, stated plainly: with `allow-scripts` and `allow-same-origin`
 * together the sandbox is not a boundary — the page can reach the API with the
 * user's session and touch `parent.document`. Real isolation needs a SEPARATE,
 * un-gated origin to serve from, which is its own piece of work.
 */
const PREVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads';

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
