import { t } from '@lingui/core/macro';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Bot, Cloud, Globe, Monitor, type LucideIcon } from 'lucide-react';
import { Layout, RuntimeKind } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { MarkdownView } from '@src/components/markdown-view';
import { notify } from '@src/notifications';
import { assistantWikiRef } from '@src/components/wiki-tip/assistant-wiki';
import { RUNTIME_CLASS } from './runtime-appearance';

/**
 * Which machine this UI is serving, as a colored chip in the navigation bar.
 *
 * It DETECTS NOTHING. The kind is resolved by the backend and arrives on
 * `bootstrapInfo.runtime.kind`; this only maps it to a label and a color. An
 * earlier version guessed from `window.location.hostname` and could not tell
 * the Electron shell from a browser tab, nor an agent's box from a user's.
 *
 * This is a safety signal — on a cloud sandbox or an agent's box it is how you
 * know whose machine you are looking at — which is why it lives in permanent
 * chrome and has no dismiss affordance. (It used to be a closable strip that
 * handed its color to the rail's Home icon when minimized; the bar is not
 * dismissible, so the signal can no longer be silenced at all.)
 *
 * Clicking it opens the "Runtime environments" wiki page.
 */

const WIKI_PAGE = 'Runtime environments';

/** Per-runtime glyphs. These describe RUNTIMES, not entity types — there is no
 *  TypeInfo for "a cloud sandbox", so `iconForType` has nothing to resolve. */
const RUNTIME_ICON: Record<RuntimeKind, LucideIcon> = {
  [RuntimeKind.HUB]: Cloud,
  [RuntimeKind.SANDBOX]: Cloud,
  [RuntimeKind.AGENT]: Bot,
  [RuntimeKind.DESKTOP]: Monitor,
  [RuntimeKind.BROWSER]: Globe,
};

function RuntimeLabel({ kind }: { kind: RuntimeKind }) {
  // "Cloud", not "Hub": the chip answers "whose machine am I on", and to a user
  // the hub backend is simply the cloud. "Hub" is our internal word for the
  // component, and it collides with the hub PAGE you can open from a desktop.
  if (kind === RuntimeKind.HUB) return <Trans>Cloud</Trans>;
  if (kind === RuntimeKind.SANDBOX) return <Trans>Cloud Sandbox</Trans>;
  if (kind === RuntimeKind.AGENT) return <Trans>Agent</Trans>;
  if (kind === RuntimeKind.BROWSER) return <Trans>Local Browser</Trans>;
  return <Trans>Desktop</Trans>;
}

/** Fetch the page body from the hub's legacy wiki route. The route returns the
 *  raw `{type, id, asset_ref, content}` shape — NO ApiResponse envelope — so
 *  the sdk apiClient (whose interceptor unwraps `response.data.data`) would
 *  yield undefined; use a plain same-origin fetch instead (hub mode serves the
 *  SPA from the hub itself, so cookie auth rides along). */
async function fetchHubWikiContent(name: string): Promise<string | null> {
  const res = await fetch(`/api/v1/wiki/resolve?${new URLSearchParams({ name })}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`wiki/resolve failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const content = body && typeof body === 'object' ? (body as { content?: unknown }).content : null;
  return typeof content === 'string' ? content : null;
}

export function RuntimeChip({ kind }: { kind: RuntimeKind }) {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const [hubDoc, setHubDoc] = useState<string | null>(null);

  const openWiki = async () => {
    // Hub: the hub has NO `wiki` graph entity (both graph resolve paths 422), so
    // the shared WikiResolveView cannot render there. Its one wiki surface is
    // the legacy `GET /api/v1/wiki/resolve?name=...`, which serves the system
    // doc's markdown `content` directly — fetch that and render it locally.
    if (kind === RuntimeKind.HUB) {
      try {
        const content = await fetchHubWikiContent(WIKI_PAGE);
        if (content) setHubDoc(content);
        else notify.error({ title: t`[[${WIKI_PAGE}]]`, message: t`Wiki page not found on this hub.` });
      } catch (err) {
        notify.error({
          title: t`[[${WIKI_PAGE}]]`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    // Desk/e2b: the `@local` wiki alias resolves against the CURRENT project, so
    // resolve the assistant project's own default wiki and open the page there.
    const wikiRef = await assistantWikiRef();
    navigation.openDock(DockPointer.forWiki(WIKI_PAGE, Layout.DOCK, wikiRef ?? undefined));
  };

  const Icon = RUNTIME_ICON[kind] ?? Monitor;

  return (
    <>
      <button
        type="button"
        onClick={() => void openWiki()}
        data-testid="top-nav-runtime-chip"
        data-runtime={kind}
        title={t`What are Flowpad's runtime environments?`}
        className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-semibold hover:opacity-90 ${RUNTIME_CLASS[kind]}`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {/* Narrow windows keep the color and drop the word — the color is the
            signal, the label is the explanation. */}
        <span className="hidden sm:inline">
          <RuntimeLabel kind={kind} />
        </span>
      </button>
      <Dialog open={hubDoc !== null} onOpenChange={(open) => !open && setHubDoc(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>[[{WIKI_PAGE}]]</DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Explanation of Flowpad's runtime environments.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="h-[70vh] overflow-auto">{hubDoc !== null && <MarkdownView value={hubDoc} />}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}
