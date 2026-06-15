import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// The store lives in src/tabs/useTabs.ts (the useActiveTerminals.ts shim
// was deleted at cutover end); the contract assertions read the real source.
const activeTerminalsSource = readFileSync(
  resolve(__dirname, '../../src/tabs/useTabs.ts'),
  'utf-8',
);
// The strip-controller logic (close dispatch included) moved from
// TabbedTerminal into the reusable useTerminalStripController hook
// (tab-management.md Part 3 §6); the contract assertions read the real source.
const stripControllerSource = readFileSync(
  resolve(__dirname, '../../src/tabs/useTerminalStripController.tsx'),
  'utf-8',
);
const standardTabNavSource = readFileSync(
  resolve(__dirname, '../../src/components/terminal/useStandardTabNav.ts'),
  'utf-8',
);

describe('terminal close-all backend contract', () => {
  it('lists terminals from the Tab entity (not the old tabs/list fetch)', () => {
    // Membership is now a visible `Tab` row resolved to its live entity.
    expect(activeTerminalsSource).toContain('useTerminalTabs');
    expect(activeTerminalsSource).toContain('match: { visible: true }');
    expect(activeTerminalsSource).not.toContain("action.subpath = 'list'");
    expect(activeTerminalsSource).not.toContain('active-terminals');
  });

  it('closes batches with one tabs/close request and no per-tab entity close loop', () => {
    expect(activeTerminalsSource).toContain("new ActionInfo('tabs', 'compute_node', computeNodeId, 'POST')");
    expect(activeTerminalsSource).toContain("action.subpath = 'close'");
    expect(activeTerminalsSource).toContain('action.bodyParameters = { targets: keys }');
    expect(stripControllerSource).toContain('closeTerminalTargets(keys)');
    expect(stripControllerSource).not.toContain('target.close()');
    expect(standardTabNavSource).toContain('string | string[]');
  });
});
