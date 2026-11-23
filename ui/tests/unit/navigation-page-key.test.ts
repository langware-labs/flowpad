/**
 * The app's page key rides every navigation made INSIDE the app: that is what tells a page opened here
 * from one a link from outside names (`PageAllowGate` asks only for the latter). Nothing is minted per
 * navigation — the key is the one the server wrote into the app's page at startup.
 */
import { DockPointer, STATE_KEY_PARAM } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { ViewType } from '@src/types/ViewType';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APP_KEY = 'a'.repeat(32);
const page = () => new DockPointer(ViewType.ASSETS, 'editor/html/vfs/compute_node-@local/Users/me/page.html');
const held = globalThis as { __FLOWPAD_STATE_KEY__?: string };

/** A window that holds no key: neither written into the page nor remembered for its reload. */
function forgetKey(): void {
  delete held.__FLOWPAD_STATE_KEY__;
  window.sessionStorage.clear();
}

/** The key on the dock `openDock` navigated to. */
function keyAfter(open: (nav: NavigationActions) => void): string | undefined {
  NavigationActions.resetPendingNavigationForTests(); // each call is its own navigation, not a repeat
  const navigate = vi.fn();
  open(new NavigationActions(navigate, null));
  return DockPointer.fromUrl(String(navigate.mock.calls[0][0])).options?.[STATE_KEY_PARAM];
}

describe('openDock and the page key', () => {
  beforeEach(() => {
    held.__FLOWPAD_STATE_KEY__ = APP_KEY;
  });
  afterEach(() => {
    forgetKey();
    NavigationActions.resetPendingNavigationForTests();
  });

  it("carries the app's key onto a target that has none", () => {
    expect(keyAfter((nav) => nav.openDock(page()))).toBe(APP_KEY);
  });

  it('leaves a key an agent opened the page with', () => {
    const agentKey = 'k'.repeat(32);
    expect(keyAfter((nav) => nav.openDock(page().withOption(STATE_KEY_PARAM, agentKey)))).toBe(agentKey);
  });

  it('adds none for a link from outside, nor when the server asks for no key', () => {
    expect(keyAfter((nav) => nav.openDock(page(), undefined, { fromOutside: true }))).toBeUndefined();
    forgetKey();
    expect(keyAfter((nav) => nav.openDock(page()))).toBeUndefined();
  });
});
