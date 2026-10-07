/**
 * Runs a link action — the one place an action id (`link-actions.ts`) becomes a call.
 * Navigation goes through `NavigationActions`; preview and copy are the two actions
 * that stay on the page.
 */
import { fsStore, type AgenticProcess } from '@sdk';
import { t } from '@lingui/core/macro';
import { errorMessage } from '@src/lib/error-message';
import { isWebUrl, lightboxMediaName } from '@src/lib/link-kind';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { notify } from '@src/notifications/notify';
import type { LinkActionId } from './link-actions';
import type { LinkSource } from './link-events';

export interface LinkMedia {
  url: string;
  name: string;
}

export type LinkAction =
  | { id: Exclude<LinkActionId, 'browser-profile'> }
  | { id: 'browser-profile'; browser: string; profile: string };

export interface LinkHandlerDeps {
  navigation: NavigationActions;
  source: LinkSource | null;
  host: AgenticProcess | null;
  preview: (media: LinkMedia) => void;
}

/**
 * The bytes behind an image/video link: a web URL as itself, a file reference as the
 * source's own machine serves it (the path the backend resolved, on its compute node).
 * A source on no node — a headless chat, a message — resolved its path on this machine,
 * which is where the backend looked (`Entity.link_node`).
 */
async function mediaFor(link: string, source: LinkSource | null): Promise<LinkMedia | null> {
  const name = lightboxMediaName(link);
  if (!name) return null;
  if (isWebUrl(link)) return { url: link, name };
  if (!source) return null;
  const node = source.computeNodeTypeId ?? LOCAL_COMPUTE_NODE;
  const path = (await source.resolveDisplayTarget(link))?.path;
  return path ? { url: fsStore.getState().getDownloadUrl(node, path), name } : null;
}

function copyLink(link: string): void {
  navigator.clipboard.writeText(link).then(
    () => notify.success({ title: t`Link copied` }),
    (error: unknown) =>
      notify.error({
        title: t`Could not copy link`,
        message: errorMessage(error, t`Clipboard unavailable`),
        forceToast: true,
      }),
  );
}

export async function runLinkAction(action: LinkAction, link: string, deps: LinkHandlerDeps): Promise<void> {
  const { navigation, source, host } = deps;
  switch (action.id) {
    case 'preview': {
      // Media previews in place; anything the preview can't resolve opens as a tab, which
      // also reports the failure the way every other link does.
      const media = await mediaFor(link, source).catch(() => null);
      if (media) deps.preview(media);
      else await navigation.openLink(link, source);
      return;
    }
    case 'show-in-display':
      if (host) await navigation.showLinkInDisplay(link, host);
      return;
    case 'open':
      return navigation.openLink(link, source);
    case 'vibe':
      if (host) await navigation.openLinkInVibe(link, source, host);
      return;
    case 'browser':
      return navigation.openLinkInBrowser(link, source);
    case 'browser-profile':
      return navigation.openLinkInBrowserProfile(link, source, action.browser, action.profile);
    case 'copy':
      return copyLink(link);
  }
}
