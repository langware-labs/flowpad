import { PageId } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import type { DockPointer } from './DockPointer';
import { isContentAssetDock, isOwnChatAssetDock, isPreviewAssetDock } from './content-asset-dock';
import { isHostDock } from './tab-hosts';

/**
 * The layout a dock renders in — step 5 of docs/navigation/dock-loading.md, and
 * the ONLY rule for it. `flow-page` renders the answer; it holds no predicates.
 *
 * A layout is a frame (chrome, a chat pane, a display pane) around the view. It
 * owns no runtime: terminals live in the TerminalPool above every layout, so a
 * change of layout can move a terminal but never rebuild one (I6).
 */
export enum DockLayout {
  /** An asset/file editor: its own chrome, and the Vibe chat beside it in Vibe mode. */
  ASSET_WORKSPACE = 'asset_workspace',
  /** Vibe: a process's own workspace (its chat + display) or a child tab opened from it. */
  VIBE_WORKSPACE = 'vibe_workspace',
  /** Vibe: the home asked to start without a process. */
  VIBE_NO_PROCESS = 'vibe_no_process',
  /** Vibe: the bare home — the centered new-chat hero. */
  VIBE_NEW_CHAT = 'vibe_new_chat',
  /** Everything else: the content panel (tab strip, navigator, view body). */
  CONTENT = 'content',
}

export interface DockLayoutInput {
  dock: DockPointer | null;
  isVibe: boolean;
  /** A Vibe workspace session resolves for this dock (`useVibeWorkspaceSession`). */
  hasVibeSession: boolean;
}

export interface DockLayoutDecision {
  layout: DockLayout;
  /** ASSET_WORKSPACE only: show the Vibe chat beside the asset (Vibe, and the asset has no chat of its own). */
  assetChatBeside: boolean;
}

/** The home surface: no dock at all, or the HOME landing. The one predicate for it. */
export function isHomeSurface(dock: DockPointer | null): boolean {
  return dock === null || dock.viewType === ViewType.HOME;
}

export function resolveDockLayout({ dock, isVibe, hasVibeSession }: DockLayoutInput): DockLayoutDecision {
  const content = { layout: DockLayout.CONTENT, assetChatBeside: false };
  // The hub page is its own SPA surface — the desk view mode does not skin it.
  const hubMode = dock?.page === PageId.HUB;
  // A `flow show`-pinned preview stays in the Vibe workspace's display pane; only
  // the agent's own pin (`isActiveDisplay`) — a file the USER opened keeps the asset chrome.
  const isPreviewDisplay = !!dock && !!dock.hostProcessId && dock.isActiveDisplay && isPreviewAssetDock(dock);
  if (dock && !hubMode && isContentAssetDock(dock) && !isPreviewDisplay) {
    // The chat beside an asset is its HOST's session (Discuss → a Vibe host tab with
    // the asset as its child), never the ambient mode. An asset with its own chat
    // (an agent) is not a Vibe surface: no Vibe chat beside it.
    return { layout: DockLayout.ASSET_WORKSPACE, assetChatBeside: !!dock.hostProcessId && !isOwnChatAssetDock(dock) };
  }
  // A HOST tab (`/dock/vibe/…`) is its workspace whatever the ambient mode — the
  // host, not the mode, decides. (Its address also implies Vibe, so today the two
  // agree; the check is what keeps a future host from depending on the mode.)
  if (!hubMode && hasVibeSession && isHostDock(dock)) return { layout: DockLayout.VIBE_WORKSPACE, assetChatBeside: false };
  if (!isVibe || hubMode) return content;
  if (hasVibeSession) return { layout: DockLayout.VIBE_WORKSPACE, assetChatBeside: false };
  const isHome = isHomeSurface(dock);
  if (isHome && dock?.options?.vibeNoProcess === 'true') return { layout: DockLayout.VIBE_NO_PROCESS, assetChatBeside: false };
  if (isHome) return { layout: DockLayout.VIBE_NEW_CHAT, assetChatBeside: false };
  // Any other real dock URL in Vibe (project home, assets list, a conversation…)
  // is a navigable destination through the normal content panel, with its own Vibe skin.
  return content;
}
