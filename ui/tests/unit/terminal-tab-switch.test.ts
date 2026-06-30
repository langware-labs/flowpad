/**
 * FLOWPAD-1645: Terminal tab switching must preserve terminal content.
 *
 * TabbedTerminal keeps all terminals mounted and hides inactive ones
 * via CSS (display:none). This prevents xterm instances from being
 * destroyed on tab switch, which caused blank terminals.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const tabbedTerminalPath = resolve(__dirname, '../../src/components/terminal/TabbedTerminal.tsx');
const tabbedTerminalSource = readFileSync(tabbedTerminalPath, 'utf-8');

// Creation flows and opener descriptors moved into the strip controller
// extracted from TabbedTerminal (tab-management.md Part 3 §6).
const stripControllerSource = readFileSync(
  resolve(__dirname, '../../src/tabs/useTerminalStripController.tsx'),
  'utf-8',
);

// Opener-button rendering moved to the TerminalOpenerToolbar sibling module;
// match against its source so the contract stays intact after the refactor.
const openerToolbarPath = resolve(__dirname, '../../src/components/terminal/openers/TerminalOpenerToolbar.tsx');
const openerToolbarSource = readFileSync(openerToolbarPath, 'utf-8');

describe('TabbedTerminal – tab switching contract (FLOWPAD-1645)', () => {
  it('renders a plain terminal button in the tab-end toolbar', () => {
    expect(openerToolbarSource).toContain("'open-terminal-tab-button'");
    expect(stripControllerSource).toContain('navigation.openNewShell');
  });

  it('locks tab creation buttons while a tab is being created', () => {
    // Opener-button rendering (incl. the disable-while-creating lock + spinner)
    // moved out of TabbedTerminal into the TerminalOpenerToolbar sibling — the
    // lock is now `opener.disabled || isTabCreationPending` driving `disabled`.
    expect(openerToolbarSource).toContain('opener.disabled || isTabCreationPending');
    expect(openerToolbarSource).toContain('disabled={disabled}');
    // Pending state drives an inline spinner (pendingInline) for each opener.
    expect(stripControllerSource).toContain('pendingInline: isClaudeCreationPending');
    expect(stripControllerSource).toContain('pendingInline: isTerminalCreationPending');
    expect(openerToolbarSource).toContain('Loader2 className="h-4 w-4 animate-spin"');
  });

  it('does NOT return null for inactive sessions (prevents unmount)', () => {
    const renderingBlock = tabbedTerminalSource.slice(tabbedTerminalSource.indexOf('data-testid="terminal-panels"'));

    // The old buggy pattern: if (!isActive) { return null; }
    const hasReturnNullForInactive = /if\s*\(\s*!isActive\s*\)\s*\{[^}]*return\s+null/s.test(renderingBlock);
    expect(hasReturnNullForInactive).toBe(false);
  });

  it('uses CSS visibility to hide inactive terminals (not display:none, so xterm gets real dimensions)', () => {
    // visibility:hidden keeps inactive terminals in layout so xterm canvas can
    // initialize with real dimensions — display:none would break this. (The
    // per-panel style lives in the TerminalPanel subcomponent.)
    expect(tabbedTerminalSource).toContain("visibility: 'hidden'");
    expect(tabbedTerminalSource).not.toContain('display: none');
  });

  it('passes active prop to terminal components', () => {
    expect(tabbedTerminalSource).toContain('active={isActive}');
  });

  it('keeps mounted terminals warm (lazy-mount set never shrinks)', () => {
    // Once mounted, a panel stays mounted (the `mounted` set only grows), so
    // re-activation is instant and PTY/canvas state is preserved.
    expect(tabbedTerminalSource).toContain('keep mounted ones');
    expect(tabbedTerminalSource).toContain('mounted.has(tabHash)');
  });
});
