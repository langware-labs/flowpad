import { describe, expect, it } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';
import { linkAtCell } from '@src/components/terminal/interactive-terminal/terminal-links';

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.terminal_wrapped_links.rules: FAILING? read this tag's rules before
//       editing terminal-links.ts continuesBelow
// flowpad:endcapsule tag
describe('terminal links: a printed path whose last row nearly fills the terminal', () => {
  it('does not glue the shell prompt on the row below onto the path', async () => {
    const cols = 40;
    // Soft-wrapped by xterm over two rows; the second ends a few cells short of the edge, so the
    // prompt word below "does not fit in the room left" — the joiner's cue for a broken path.
    const path = '/tmp/qtl/project-ab12/' + 'long-directory-'.repeat(2) + '/wrapped-probe.txt';
    expect(path.length).toBeGreaterThan(cols);
    expect(cols - (path.length - cols) - 1).toBeLessThan('flowpad-workload%'.length);
    const terminal = new HeadlessTerminal({ cols, rows: 6, allowProposedApi: true });
    try {
      // zsh: the output line, its end-of-line mark row (`%` + spaces, then CR), and a bare prompt with nothing typed.
      const mark = '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m' + ' '.repeat(cols - 1) + '\r \r';
      await new Promise<void>((resolve) => terminal.write(`${path}\r\n${mark}\rflowpad-workload% `, resolve));
      expect(linkAtCell(terminal as unknown as Terminal, 30, 2)).toBe(path);
      expect(linkAtCell(terminal as unknown as Terminal, 5, 1)).toBe(path);
    } finally {
      terminal.dispose();
    }
  });

  it('does not glue the prompt on when the path fills its last row to the edge', async () => {
    const cols = 40;
    // Exactly two full rows: the second ends at the edge, so the row below reads like a TUI's cut path.
    const path = '/tmp/ql/' + 'long-directory-'.repeat(4) + '/wrapped.txt';
    expect(path.length).toBe(2 * cols);
    const terminal = new HeadlessTerminal({ cols, rows: 6, allowProposedApi: true });
    try {
      const mark = '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m' + ' '.repeat(cols - 1) + '\r \r';
      await new Promise<void>((resolve) => terminal.write(`${path}\r\n${mark}\rflowpad-workload% `, resolve));
      expect(linkAtCell(terminal as unknown as Terminal, 30, 2)).toBe(path);
      expect(linkAtCell(terminal as unknown as Terminal, 5, 1)).toBe(path);
    } finally {
      terminal.dispose();
    }
  });
});
