/**
 * What a detected link IS — the classification every link surface shares. Pure: no
 * DOM, no navigation. Detection (`link-matches.ts`) finds a link in text; this says
 * which kind it is; `components/links/link-actions.ts` decides what can be done with it.
 */
import { isLightboxMedia } from '@src/components/ui/media-lightbox';

/**
 * - `web`    — an http(s) page on another origin.
 * - `app`    — an address inside this app (`/dock/…`, or this origin's URL of one).
 * - `entity` — a TypeId (`skill-<uuid>`).
 * - `file`   — a path or `file://` URL, resolved by the backend against the link's source.
 */
export type LinkKind = 'web' | 'app' | 'entity' | 'file';

const APP_PATH = /^\/(dock|win|dev)\//;
const TYPE_ID = /^[a-z_]+-(?:@[\w.-]+|[0-9a-f]{8}-[0-9a-f-]{27})$/i;
/** A position suffix a file reference may carry: `a.png:3`, `a.png:3:7`, `a.png#L3`. */
const POSITION_SUFFIX = /(?::\d+(?::\d+)?|#L\d+)$/;

export const isWebUrl = (link: string): boolean => /^https?:\/\//i.test(link);

/** The in-app address an app URL copied from this browser names, or null when it is not one. */
export function appLinkPath(link: string, origin: string): string | null {
  if (APP_PATH.test(link)) return link;
  if (!isWebUrl(link)) return null;
  try {
    const url = new URL(link);
    return url.origin === origin && APP_PATH.test(url.pathname) ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

export function linkKind(link: string, origin: string): LinkKind {
  if (appLinkPath(link, origin)) return 'app';
  if (isWebUrl(link)) return 'web';
  if (TYPE_ID.test(link)) return 'entity';
  return 'file';
}

/**
 * The file name to preview a link by, or null when it is not an image or video.
 * A web URL is judged by its path (not its query); a file reference, without its position.
 */
export function lightboxMediaName(link: string): string | null {
  let name = link;
  if (isWebUrl(link)) {
    try {
      name = new URL(link).pathname;
    } catch {
      return null;
    }
  } else {
    name = link.replace(POSITION_SUFFIX, '');
  }
  return isLightboxMedia(name) ? name.split(/[/\\]/).pop() || name : null;
}
