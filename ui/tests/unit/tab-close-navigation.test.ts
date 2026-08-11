/**
 * Live-QA regressions from the unified-strip matrix run (tab-management.md
 * Part 3 §11, 2026-06-11) — two navigation bugs found in the browser and
 * fixed; these source contracts keep them fixed:
 *
 * 1. closeDock at a ROOT-level dock URL: `stripDockPortion('/dock/settings')`
 *    is '' and react-router treats `navigate('')` as a relative no-op, so the
 *    transient tab's X silently did nothing outside the /agent|/flow
 *    namespaces. openDock(null) must normalize the empty base to '/'.
 *
 * 2. Closing a BACKGROUND tab must not navigate. The strip is app-global now;
 *    useStandardTabNav's old unconditional shell-view fallback (written when
 *    the strip only rendered inside the shell view) yanked the user off
 *    whatever view they were reading. onTabClose may navigate only when the
 *    closed set includes the tab the URL is currently showing.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';

const navigationActionsSource = readFileSync(
  resolve(__dirname, '../../src/navigation/NavigationActions.ts'),
  'utf-8',
);
const unifiedStripSource = readFileSync(
  resolve(__dirname, '../../src/pages/flow-page/content-panel/unified-tab-strip.tsx'),
  'utf-8',
);

describe('strip width containment (live-QA regression, 2026-06-11)', () => {
  // The unified strip blew its flex ancestors out to the sum of all chip
  // widths (~14k px), pushing the right arrow / close-all / opener toolbar
  // off-screen and making tab navigation look dead. Both the strip root and
  // the flow-page main column must stay width-constrained.
  it('TabStrip root is min-w-0/max-w-full', () => {
    const tabStripSource = readFileSync(
      resolve(__dirname, '../../src/components/tabs/TabStrip.tsx'),
      'utf-8',
    );
    // Assert the width-containment invariant only (min-w-0/max-w-full so the
    // strip never sizes its host to content) — NOT the cross-axis alignment,
    // which is a free layout choice (currently items-end) and must not pin
    // this regression test.
    expect(tabStripSource).toContain('flex min-w-0 max-w-full');
  });

  it('flow-page main column carries min-w-0', () => {
    const flowPageSource = readFileSync(
      resolve(__dirname, '../../src/pages/flow-page/flow-page.tsx'),
      'utf-8',
    );
    expect(flowPageSource).toContain('flex min-w-0 flex-1 flex-col');
  });
});

describe('closeDock from root-level dock URLs', () => {
  // Was a source-text assertion on the hand-rolled `stripDockPortion(...) || '/'`.
  // Closing the dock IS going to the root, and the root is an ordinary pointer
  // now, so assert the behaviour: a root-level dock URL lands on `/`, and one
  // under an agent/flow prefix keeps that prefix.
  const closeFrom = (path: string): string => {
    window.history.pushState({}, '', path);
    const navigate = vi.fn();
    new NavigationActions(navigate, DockPointer.fromUrl(path)).openDock(null);
    return String(navigate.mock.calls[0][0]);
  };

  afterEach(() => NavigationActions.resetPendingNavigationForTests());

  it('lands on the app root', () => {
    expect(closeFrom('/dock/assets/list/skill')).toBe('/');
  });

  it('keeps an agent/flow base path', () => {
    expect(closeFrom('/agent/a/flow/f/dock/assets/list/skill')).toBe('/agent/a/flow/f');
  });
});

describe('UnifiedTabStrip close navigation', () => {
  it('only navigates when the closed tab is the one on screen', () => {
    // The strip navigates off a close ONLY for the chip that is on screen —
    // closing a background tab leaves the view untouched. The guard is
    // `isCurrentTab(key)`, keyed on `activeKey` (the chip actually lit, which an
    // ancestor can stand in for) or `pendingActiveKey` (the
    // close-X-during-pending-nav self-heal). Both originate at the URL.
    expect(unifiedStripSource).toContain('if (isCurrentTab(key))');
    expect(unifiedStripSource).toContain('key === activeKey || key === pendingActiveKey');
    expect(unifiedStripSource).toContain("currentDock?.tabHash ?? ''");
  });
});
