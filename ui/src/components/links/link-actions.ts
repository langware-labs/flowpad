/**
 * What can be done with a link — data only. The click runs `primary`; the right-click
 * menu lists `menu` in order. Nothing here navigates: `link-handlers.ts` runs an action,
 * `LinkMenu.tsx` labels it. Every link surface (terminal, message, chat) asks this.
 */
import type { LinkKind } from '@src/lib/link-kind';

/** Where a command link runs. The last one picked is what a click does next. */
export type CommandMode = 'run-here' | 'run-flowpad' | 'run-external';
export const COMMAND_MODES: readonly CommandMode[] = ['run-here', 'run-flowpad', 'run-external'];

export type LinkActionId =
  | 'preview'
  | 'show-in-display'
  | 'open'
  | 'vibe'
  | 'browser'
  | 'browser-profile'
  | 'copy'
  | CommandMode
  /** The "Browser ▸" submenu: which profile pages the command opens land in. */
  | 'command-browser'
  /** No action: the click opens the menu instead (a command someone else wrote). */
  | 'menu';

/** `vibe`: the surface sits in a vibe workspace whose Display the host owns; `tab`: anywhere else. */
export type LinkSurface = 'vibe' | 'tab';

export interface LinkContext {
  kind: LinkKind;
  /** An image or video the lightbox can show. */
  media: boolean;
  surface: LinkSurface;
  /** The surface belongs to an agentic process. */
  host: boolean;
  /** The surface can run a command itself: an agent session's shell mode, or the terminal it shows. */
  here?: boolean;
  /** The surface's machine is the one the user sits at, so its terminal windows and browsers are visible. */
  localNode?: boolean;
  /** The text came from the user's own agent or terminal, not from another person. */
  trusted?: boolean;
  /** The mode the user picked last. */
  lastMode?: CommandMode;
}

export interface LinkActionPlan {
  primary: LinkActionId;
  menu: LinkActionId[];
}

function commandActions({ here = false, localNode = true, trusted = true, lastMode = 'run-here' }: LinkContext): LinkActionPlan {
  const modes = COMMAND_MODES.filter((mode) => (mode === 'run-here' ? here : mode === 'run-external' ? localNode : true));
  const menu: LinkActionId[] = [...modes];
  if (localNode) menu.push('command-browser');
  menu.push('copy');
  const primary = !trusted ? 'menu' : modes.includes(lastMode) ? lastMode : modes[0];
  return { primary, menu };
}

export function linkActions(context: LinkContext): LinkActionPlan {
  if (context.kind === 'command') return commandActions(context);
  const { media, surface, host } = context;
  const display = surface === 'vibe' && host;
  const menu: LinkActionId[] = ['copy'];
  if (display) menu.push('show-in-display');
  menu.push('open');
  if (host && !display) menu.push('vibe');
  menu.push('browser', 'browser-profile');
  return { primary: media ? 'preview' : display ? 'show-in-display' : 'open', menu };
}
