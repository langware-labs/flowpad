import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { dataManager, FLOWPAD_ASSISTANT_PROJECT_UNAME, Layout, Project, TypeId } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { MarkdownView } from '@src/components/markdown-view';
import { notify } from '@src/notifications';

/**
 * EnvironmentBanner — thin strip at the top of the home pages that color-codes
 * which of the three FlowPad runtimes this UI is serving:
 *
 *   hub      — grey, contrast-flipped per theme (dark grey on light, light grey
 *              on dark) so it reads as "neutral chrome" in both modes
 *   e2b      — blue: the app inside an E2B cloud sandbox (detected by the
 *              sandbox public-URL host, `<port>-<sandbox-id>.e2b.dev`)
 *   desktop  — green: the local desktop app (everything else)
 *
 * Clicking the banner opens the "Runtime environments" wiki page (a system doc
 * shipped with the Flowpad Assistant project).
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

export type RuntimeKind = 'hub' | 'e2b' | 'desktop';

export function detectRuntime(): RuntimeKind {
  if (isHubOnly()) return 'hub';
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  if (host.endsWith('.e2b.dev') || host.endsWith('.e2b.app')) return 'e2b';
  return 'desktop';
}

const BANNER_CLASS: Record<RuntimeKind, string> = {
  hub: 'bg-neutral-600 text-neutral-50 dark:bg-neutral-300 dark:text-neutral-900',
  e2b: 'bg-blue-600 text-white',
  desktop: 'bg-green-600 text-white',
};

function RuntimeLabel({ kind }: { kind: RuntimeKind }) {
  if (kind === 'hub') return <Trans>Hub</Trans>;
  if (kind === 'e2b') return <Trans>Cloud Sandbox</Trans>;
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
  const kind = detectRuntime();
  const [hubDoc, setHubDoc] = useState<string | null>(null);

  const openWiki = async () => {
    if (isHubOnly()) {
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

  return (
    <>
      <button
        type="button"
        onClick={() => void openWiki()}
        data-testid="environment-banner"
        data-runtime={kind}
        title="What are Flowpad's runtime environments?"
        className={`flex w-full shrink-0 cursor-pointer items-center justify-center py-1 text-xs font-medium hover:opacity-90 ${BANNER_CLASS[kind]}`}
      >
        <RuntimeLabel kind={kind} />
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
