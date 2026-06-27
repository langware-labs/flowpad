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
import { describe, expect, it } from 'vitest';

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
  it('normalizes the stripped base to the app root', () => {
    expect(navigationActionsSource).toContain("stripDockPortion(currentPath) || '/'");
  });
});

describe('UnifiedTabStrip close navigation', () => {
  it('only navigates when the closed tab is the URL-active one', () => {
    // The strip navigates off a close ONLY for the active chip (`key === activeKey`);
    // closing a background tab leaves the current view untouched. Active key is
    // URL-derived (`currentDock.tabHash`) — URL-first.
    expect(unifiedStripSource).toContain('if (key === activeKey)');
    expect(unifiedStripSource).toContain("currentDock?.tabHash ?? ''");
  });
});
