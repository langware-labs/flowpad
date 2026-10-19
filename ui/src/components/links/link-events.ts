import type { MouseEvent as ReactMouseEvent } from 'react';
import type { AnyEntity, TypeId } from '@sdk';

/**
 * The entity a link is resolved against (`resolveDisplayTarget`): a terminal's Shell, a
 * message's FlowMessage. A relative path resolves where the source lives; a source on a
 * compute node can also preview a referenced image in place.
 */
export type LinkSource = AnyEntity & { project_id?: string | null; computeNodeTypeId?: TypeId | null };

/** What a surface does with its links — the terminal and a message share these. */
export interface LinkHandlers {
  activate: (event: MouseEvent, link: string) => void;
  /** Right-click on a link: the surface has already claimed the event. */
  openMenu: (link: string, clientX: number, clientY: number) => void;
}

/**
 * Only a plain primary click activates a link. xterm fires on mouseup for ANY button, and a
 * macOS ctrl-click is a right-click, so either would navigate underneath the link menu.
 */
export function isPrimaryClick(event: { button: number; ctrlKey: boolean }): boolean {
  return event.button === 0 && !(event.ctrlKey && /Mac/i.test(navigator.userAgent));
}

/** A drag that selected text is a selection, not a click. */
function selectedText(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

/** The click and right-click of a link rendered as DOM — the terminal's rules, on an element. */
export function linkEventProps(handlers: LinkHandlers, link: string) {
  return {
    'data-link': link,
    onClick: (event: ReactMouseEvent) => {
      if (!isPrimaryClick(event) || selectedText()) return;
      event.preventDefault();
      handlers.activate(event.nativeEvent, link);
    },
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      handlers.openMenu(link, event.clientX, event.clientY);
    },
  };
}
