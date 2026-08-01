import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import { dataManager, FLOWPAD_ASSISTANT_PROJECT_UNAME, Layout, Project, RuntimeKind, TypeId } from '@sdk';
import { useContext } from '@src/hooks/useContext';
import { RUNTIME_CLASS } from './runtime-appearance';
import { minimizeBanner, useBannerMinimized } from './use-banner-minimized';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { MarkdownView } from '@src/components/markdown-view';
import { notify } from '@src/notifications';

/**
 * EnvironmentBanner — the app's topmost strip, spanning the FULL window width
 * above the rail and the content column (mounted once in `FlowPage`, not per
 * page), color-coding which FlowPad runtime this UI is serving.
 *
 * It DETECTS NOTHING. The kind is resolved by the backend and arrives on
 * `bootstrapInfo.runtime.kind`; this component only maps it to a label and a
 * color. The previous version guessed from `window.location.hostname` and could
 * not tell the Electron shell from a browser tab, nor an agent's box from a
 * user's — both of which are now distinct kinds the server reports.
 *
 * Clicking the label opens the "Runtime environments" wiki page (a system doc
 * shipped with the Flowpad Assistant project). Closing it minimizes the strip
 * into the rail's Home icon, which then carries the runtime color — the signal
 * is never lost, only made small. See `use-banner-minimized` for why that lasts
 * exactly until the next restart.
 *
 * The root is a `div`, not a `button`: it holds two independent controls (open
 * the wiki, minimize), and a button inside a button is invalid HTML that React
 * will warn about and screen readers mis-announce.
 *
 * Desk/e2b: the `@local` wiki alias resolves against the CURRENT project, so
 * the click resolves the assistant project's own default wiki and opens the
 * page in that space via the dock wiki view.
 *
 * Hub: the hub has NO `wiki` graph entity (both graph resolve paths 422), so
 * the shared WikiResolveView cannot render there. Its one wiki surface is the
 * legacy `GET /api/v1/wiki/resolve?name=...`, which serves the system doc's
 * markdown `content` directly — fetch that and render it in a local dialog.
 */

const WIKI_PAGE = 'Runtime environments';

function RuntimeLabel({ kind }: { kind: RuntimeKind }) {
  if (kind === RuntimeKind.HUB) return <Trans>Hub</Trans>;
  if (kind === RuntimeKind.SANDBOX) return <Trans>Cloud Sandbox</Trans>;
  if (kind === RuntimeKind.AGENT) return <Trans>Agent</Trans>;
  if (kind === RuntimeKind.BROWSER) return <Trans>Local Browser</Trans>;
  return <Trans>Desktop</Trans>;
}

/** The Flowpad Assistant system project's default wiki id, where the shipped
 *  "Runtime environments" page lives — the `@local` alias would resolve the
 *  ACTIVE project's wiki instead, which doesn't carry the system docs. */
async function assistantWikiRef(): Promise<string | null> {
  try {
    const project = await dataManager.getByTypeId<Project>(
      new TypeId(Project.type, `@${FLOWPAD_ASSISTANT_PROJECT_UNAME}`),
    );
    if (!project) return null;
    const wiki = await project.getDefaultWiki();
    return wiki?.id ?? null;
  } catch {
    return null;
  }
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

export function EnvironmentBanner() {
  const { navigation } = useDockNavigation();
  const { runtimeKind: kind } = useContext();
  const { t } = useLingui();
  const minimized = useBannerMinimized();
  const [hubDoc, setHubDoc] = useState<string | null>(null);

  const openWiki = async () => {
    if (kind === RuntimeKind.HUB) {
      try {
        const content = await fetchHubWikiContent(WIKI_PAGE);
        if (content) setHubDoc(content);
        else notify.error({ title: `[[${WIKI_PAGE}]]`, message: 'Wiki page not found on this hub.' });
      } catch (err) {
        notify.error({
          title: `[[${WIKI_PAGE}]]`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    const wikiRef = await assistantWikiRef();
    navigation.openDock(DockPointer.forWiki(WIKI_PAGE, Layout.DOCK, wikiRef ?? undefined));
  };

  // Minimized: the rail's Home icon carries the color instead. Rendering
  // nothing here (rather than a zero-height strip) keeps the layout honest —
  // the content column really does get the row back.
  if (minimized) return null;

  return (
    <>
      <div
        data-testid="environment-banner"
        data-runtime={kind}
        className={`relative flex w-full shrink-0 items-center justify-center py-1 text-xs font-medium ${RUNTIME_CLASS[kind]}`}
      >
        <button
          type="button"
          onClick={() => void openWiki()}
          data-testid="environment-banner-label"
          title="What are Flowpad's runtime environments?"
          className="cursor-pointer hover:opacity-90"
        >
          <RuntimeLabel kind={kind} />
        </button>
        {/* Absolutely positioned so the label stays centred on the WINDOW, not
            on the space left over beside the close button. */}
        <button
          type="button"
          onClick={minimizeBanner}
          data-testid="environment-banner-close"
          title={t`Minimize to the Home icon (returns on restart)`}
          aria-label={t`Minimize environment banner`}
          className="absolute right-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm opacity-70 hover:bg-black/20 hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
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
