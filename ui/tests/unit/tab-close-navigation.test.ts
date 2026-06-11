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
const standardTabNavSource = readFileSync(
  resolve(__dirname, '../../src/components/terminal/useStandardTabNav.ts'),
  'utf-8',
);

describe('closeDock from root-level dock URLs', () => {
  it('normalizes the stripped base to the app root', () => {
    expect(navigationActionsSource).toContain("stripDockPortion(currentPath) || '/'");
  });
});

describe('useStandardTabNav close navigation', () => {
  it('only navigates when the closed set includes the URL-active tab', () => {
    expect(standardTabNavSource).toContain('!closed.has(urlKey)');
    // The guard derives the active key from the URL (currentDock), never from
    // local state — URL-first.
    expect(standardTabNavSource).toContain('currentDock?.viewType === ViewType.SHELL');
  });

  it('does not navigate unconditionally on empty MRU anymore', () => {
    expect(standardTabNavSource).not.toContain('const nextId = mruRef.current[0]');
  });
});
