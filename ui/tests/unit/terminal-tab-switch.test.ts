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

const tabbedTerminalPath = resolve(
  __dirname,
  '../../src/components/terminal/TabbedTerminal.tsx',
);
const tabbedTerminalSource = readFileSync(tabbedTerminalPath, 'utf-8');

describe('TabbedTerminal – tab switching contract (FLOWPAD-1645)', () => {
  it('renders a plain terminal button in the tab-end toolbar', () => {
    expect(tabbedTerminalSource).toContain('data-testid="open-terminal-tab-button"');
    expect(tabbedTerminalSource).toContain('await navigation.openNewShell()');
  });

  it('locks tab creation buttons while a tab is being created', () => {
    expect(tabbedTerminalSource).toContain('disabled={isTabCreationPending}');
    expect(tabbedTerminalSource).toContain("data-state={isClaudeCreationPending ? 'waiting' : 'idle'}");
    expect(tabbedTerminalSource).toContain("data-state={isTerminalCreationPending ? 'waiting' : 'idle'}");
    expect(tabbedTerminalSource).toContain('Loader2 className="h-4 w-4 animate-spin"');
  });

  it('does NOT return null for inactive sessions (prevents unmount)', () => {
    const renderingBlock = tabbedTerminalSource.slice(tabbedTerminalSource.indexOf('data-testid="terminal-panels"'));

    // The old buggy pattern: if (!isActive) { return null; }
    const hasReturnNullForInactive = /if\s*\(\s*!isActive\s*\)\s*\{[^}]*return\s+null/s.test(renderingBlock);
    expect(hasReturnNullForInactive).toBe(false);
  });

  it('uses CSS visibility to hide inactive terminals (not display:none, so xterm gets real dimensions)', () => {
    const renderingBlock = tabbedTerminalSource.slice(tabbedTerminalSource.indexOf('data-testid="terminal-panels"'));

    // visibility:hidden keeps inactive terminals in layout so xterm canvas
    // can initialize with real dimensions — display:none would break this.
    expect(renderingBlock).toContain("visibility: 'hidden'");
  });

  it('passes active prop to terminal components', () => {
    expect(tabbedTerminalSource).toContain('active={isActive}');
  });

  it('keeps all terminals mounted (comment documents intent)', () => {
    expect(tabbedTerminalSource).toContain('Keep all terminals mounted');
  });
});
