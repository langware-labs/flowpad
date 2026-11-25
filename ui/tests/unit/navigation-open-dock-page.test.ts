import { dataContext } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedBootstrap } from '../utils/dock-loader-harness';

const CONVERSATION = '9ca011c5-7386-418f-a11c-38e9c66b396b';
const MESSAGE = '021d0070-6b8e-45d3-ad03-a7933d28160a';

/**
 * openDock and the page the server serves. Every `DockPointer.forX()` is a desk
 * pointer; on a hub-only server openDock moves it to the hub, so a caller that
 * never says `.withPage(PageId.HUB)` (the conversation's message click) stays put
 * instead of being redirected to the hub home.
 */
describe('NavigationActions.openDock — served page', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    dataContext.bootstrapInfo = null;
  });

  function clickMessage(supportedPages: string[]): string {
    window.history.pushState({}, '', `/dock/hub/conversation/${CONVERSATION}`);
    seedBootstrap({ supported_pages: supportedPages });
    const navigate = vi.fn();
    new NavigationActions(navigate, null).openDock(DockPointer.forConversation(CONVERSATION, { messageId: MESSAGE }));
    return String(navigate.mock.calls[0][0]).split('?')[0];
  }

  it('hub-only server: a desk pointer opens on the hub', () => {
    expect(clickMessage(['hub'])).toBe(`/dock/hub/conversation/${CONVERSATION}/message/${MESSAGE}`);
  });

  it('server with both pages: the pointer is opened as built', () => {
    expect(clickMessage(['desk', 'hub'])).toBe(`/dock/conversation/${CONVERSATION}/message/${MESSAGE}`);
  });
});
