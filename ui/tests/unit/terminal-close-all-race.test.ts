import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// The store moved to src/tabs/useTabs.ts (useActiveTerminals.ts is a pure
// re-export shim); the contract assertions read the real source.
const activeTerminalsSource = readFileSync(
  resolve(__dirname, '../../src/tabs/useTabs.ts'),
  'utf-8',
);
const tabbedTerminalSource = readFileSync(
  resolve(__dirname, '../../src/components/terminal/TabbedTerminal.tsx'),
  'utf-8',
);
const standardTabNavSource = readFileSync(
  resolve(__dirname, '../../src/components/terminal/useStandardTabNav.ts'),
  'utf-8',
);

describe('terminal close-all backend contract', () => {
  it('lists tabs through the unified tabs/list action', () => {
    expect(activeTerminalsSource).toContain("new ActionInfo('tabs', 'compute_node', computeNodeId, 'GET')");
    expect(activeTerminalsSource).toContain("action.subpath = 'list'");
    expect(activeTerminalsSource).not.toContain('active-terminals');
    expect(activeTerminalsSource).not.toContain('closedTerminalKeys');
  });

  it('closes batches with one tabs/close request and no per-tab entity close loop', () => {
    expect(activeTerminalsSource).toContain("new ActionInfo('tabs', 'compute_node', computeNodeId, 'POST')");
    expect(activeTerminalsSource).toContain("action.subpath = 'close'");
    expect(activeTerminalsSource).toContain('action.bodyParameters = { targets: keys }');
    expect(tabbedTerminalSource).toContain('closeTerminalTargets(keys)');
    expect(tabbedTerminalSource).not.toContain('target.close()');
    expect(standardTabNavSource).toContain('string | string[]');
  });
});
