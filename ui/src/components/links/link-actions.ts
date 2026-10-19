/**
 * What can be done with a link — data only. The click runs `primary`; the right-click
 * menu lists `menu` in order. Nothing here navigates: `link-handlers.ts` runs an action,
 * `LinkMenu.tsx` labels it. Every link surface (terminal, message, chat) asks this.
 */
import type { LinkKind } from '@src/lib/link-kind';

export type LinkActionId = 'preview' | 'show-in-display' | 'open' | 'vibe' | 'browser' | 'browser-profile' | 'copy';

/** `vibe`: the surface sits in a vibe workspace whose Display the host owns; `tab`: anywhere else. */
export type LinkSurface = 'vibe' | 'tab';

export interface LinkContext {
  kind: LinkKind;
  /** An image or video the lightbox can show. */
  media: boolean;
  surface: LinkSurface;
  /** The surface belongs to an agentic process. */
  host: boolean;
}

export interface LinkActionPlan {
  primary: LinkActionId;
  menu: LinkActionId[];
}

export function linkActions({ media, surface, host }: LinkContext): LinkActionPlan {
  const display = surface === 'vibe' && host;
  const menu: LinkActionId[] = ['copy'];
  if (display) menu.push('show-in-display');
  menu.push('open');
  if (host && !display) menu.push('vibe');
  menu.push('browser', 'browser-profile');
  return { primary: media ? 'preview' : display ? 'show-in-display' : 'open', menu };
}
