import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const shellEntitySource = readFileSync(
  resolve(__dirname, '../../../ts_sdk/src/entities/shell.ts'),
  'utf-8',
);
const tabbedTerminalSource = readFileSync(
  resolve(__dirname, '../../src/components/terminal/TabbedTerminal.tsx'),
  'utf-8',
);
const contentPanelSource = readFileSync(
  resolve(__dirname, '../../src/pages/flow-page/content-panel/content-panel.tsx'),
  'utf-8',
);

describe('Terminal shell state guards', () => {
  it('tracks closing as a shell status instead of a local ui-only map', () => {
    expect(shellEntitySource).toContain("CLOSING: 'closing'");
    expect(shellEntitySource).toContain('this.status = ShellStatus.CLOSING;');
    expect(tabbedTerminalSource).not.toContain('uiShellStatuses');
  });

  it('does not treat a missing cached tab as a disconnected shell', () => {
    expect(contentPanelSource).not.toContain('(!tab && terminalTabs.length > 0)');
    // Redirect-off-active fires only when the URL's active row is closing.
    expect(contentPanelSource).toContain('if (active?.is_disabled) {');
  });
});
