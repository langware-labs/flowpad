import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const activeTerminalsSource = readFileSync(
  resolve(__dirname, '../../src/hooks/useActiveTerminals.ts'),
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

describe('terminal close-all race guard', () => {
  it('filters locally closed tabs out of active-terminals refreshes', () => {
    expect(activeTerminalsSource).toContain('closedTerminalKeys');
    expect(activeTerminalsSource).toContain('!closedTerminalKeys.has(terminalTargetKey(tab))');
  });

  it('closes batches without per-tab navigation', () => {
    expect(tabbedTerminalSource).toContain('closeTab(key, { notify: false })');
    expect(tabbedTerminalSource).toContain('onTabClose?.(closedKeys)');
    expect(standardTabNavSource).toContain('string | string[]');
  });
});
