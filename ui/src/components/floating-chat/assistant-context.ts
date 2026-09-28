import { VIEWER_REGISTRY } from '@src/types/ViewType';
import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * The Flowpad Assistant keeps ONE chat per dock context: the context a chat was
 * started on is the chat's identity, stamped on the process as `context_key`.
 *
 * The key is the tab (`tabHash`) narrowed to what the tab shows. A scope-keyed
 * view (Assets, Explorer) folds every document it opens into one tab, so its
 * hash alone would give every agent/doc in a project the same chat — the
 * pointer is added back for those. A dock with no tab (Home and the other
 * full-bleed surfaces) keys on its view.
 */
export function assistantContextKey(dock: DockPointer | null): string {
  if (!dock?.viewType) return 'root';
  const tab = dock.tabHash;
  if (!tab) return `view|${dock.page}|${dock.viewType}`;
  return VIEWER_REGISTRY[dock.viewType]?.scopeKeyed ? `${tab}|${dock.pointer ?? ''}` : tab;
}

/**
 * The standing direction a chat is created with (its system-prompt append):
 * what the user had open when the chat started. Fixed for the chat's life —
 * a different context is a different chat.
 */
export function assistantContextInstructions(
  dock: DockPointer | null,
  crumbs: ReadonlyArray<{ label: string; path?: string | null; directory?: boolean }>,
): string {
  if (!dock?.viewType) {
    return 'This Flowpad Assistant chat was started from the Flowpad home screen.';
  }
  const where =
    crumbs
      .map((c) => c.label)
      .filter(Boolean)
      .join(' › ') || dock.viewType;
  const target = dock.targetTypeId?.toString();
  // Where the shown thing lives on disk — without it the worker goes looking.
  const onDisk = crumbs.find((c) => c.path)?.path;
  return [
    `This Flowpad Assistant chat belongs to the Flowpad page the user has open: ${where}.`,
    `View: \`${dock.viewType}\`; address: \`${dock.toUrl()}\`${target ? `; entity: \`${target}\`` : ''}.`,
    ...(onDisk ? [`It lives on disk at \`${onDisk}\` — read it there; do not search for it.`] : []),
    'Treat that page as the subject of the conversation — "this" and "it" refer to it. ' +
      'Run `flow context list` if you need the live state of the page.',
  ].join('\n');
}
