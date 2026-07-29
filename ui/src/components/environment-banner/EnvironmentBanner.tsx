import { Trans } from '@lingui/react/macro';
import { dataManager, FLOWPAD_ASSISTANT_PROJECT_UNAME, Layout, Project, TypeId } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { openWikiModal } from '@src/components/wiki-tip/wiki-modal';

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
 * shipped with the Flowpad Assistant project). The `@local` wiki alias resolves
 * against the CURRENT project, so the click resolves the assistant project's
 * own default wiki first and opens the page in that space; hub mode falls back
 * to the wiki modal (the hub page has no /dock/assets/wiki route).
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

export function EnvironmentBanner() {
  const { navigation } = useDockNavigation();
  const kind = detectRuntime();
  const openWiki = async () => {
    if (isHubOnly()) {
      openWikiModal(WIKI_PAGE);
      return;
    }
    const wikiRef = await assistantWikiRef();
    navigation.openDock(DockPointer.forWiki(WIKI_PAGE, Layout.DOCK, wikiRef ?? undefined));
  };
  return (
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
  );
}
