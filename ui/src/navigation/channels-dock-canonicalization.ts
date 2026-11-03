import { PageId } from '@sdk';
import { CHANNELS_SEGMENT } from '@src/components/data-sources/data-sources-pointer';
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from './DockPointer';
import { tryParseDock } from './try-parse-dock';

/**
 * Data sources › Channels retired into the one Channels screen (`/dock/inbound`): every channel and where its
 * messages go, the same component on the hub page and the desktop. The old address survives only as a decodable URL
 * so links and bookmarks keep working. Pure — the root loader owns the redirect, before anything is written.
 */
export function canonicalChannelsDockPath(pathname: string, search: string): string | null {
  // Every navigation runs this: a string test first, so only the one retired address is parsed.
  if (!pathname.endsWith(`/${CHANNELS_SEGMENT}`) && !pathname.includes(`/${CHANNELS_SEGMENT}/`)) return null;
  const dock = tryParseDock(`${pathname}${search}`);
  if (!dock || dock.viewType !== ViewType.DATA_SOURCES || dock.pointer !== CHANNELS_SEGMENT) return null;
  return new DockPointer(ViewType.INBOUND, undefined, dock.options, dock.layout, PageId.DESK).toUrl(pathname);
}
