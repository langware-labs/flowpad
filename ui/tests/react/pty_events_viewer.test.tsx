/**
 * Renders PTYEventsViewer with a real PtyConnection underneath, feeds chunks
 * through the connection, and asserts the modal UI updates:
 *   - "registered watchers: N" reflects the trigger count
 *   - "fires: N" reflects fire count
 *   - the matching line appears as a table row with the trigger's label
 *
 * Proves the full pipeline: PTY chunks → line buffer → trigger match →
 * fire ring buffer → onPtyEventFire subscription → React state → DOM.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { PtyConnection } from '@sdk/services/shell/ptyConnection';
import { PTYEventsViewer } from '@src/components/terminal/interactive-terminal/pty-events-viewer/PTYEventsViewer';
import { unitTestSetup } from '../utils/test-utils';

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

/** Build a minimal Shell-shaped object that PTYEventsViewer can consume.
 *  Wraps a real PtyConnection — no mocking of the trigger / fire pipeline. */
function makeShellLike(pty: PtyConnection, id = 'test-shell-12345678') {
  return {
    id,
    getPtyEventFires: () => pty.getEventFires(),
    onPtyEventFire: (fn: (f: any) => void) => pty.onEventFire(fn),
    getRegisteredPtyEventCount: () => pty.getRegisteredEventCount(),
    addTrigger: (t: any) => pty.addTrigger(t),
  } as any;
}

describe('PTYEventsViewer end-to-end UI', () => {
  beforeEach(async () => {
    await unitTestSetup();
  });

  it('shows "registered watchers: N" and the fire row when a trigger matches input', async () => {
    const pty = new PtyConnection('test-shell-12345678', 'test-node');
    // Open the live gate so non-replay fires also surface.
    (pty as unknown as { _attached: boolean })._attached = true;

    const shell = makeShellLike(pty);

    // Register the trigger BEFORE rendering — mimics the InteractiveTerminal
    // useEffect path that calls process.onPlan() → shell.addTrigger().
    shell.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      label: 'plan-detection',
      onMatch: () => {},
    });

    let openState = true;
    const onClose = () => { openState = false; };

    render(<PTYEventsViewer open={openState} onClose={onClose} shell={shell} />);

    // 1. Watcher counter shows 1 immediately on open.
    await waitFor(() => {
      expect(screen.getByText(/registered watchers:/i).textContent).toMatch(/registered watchers:\s*1/);
    });
    // 2. Fires count is 0 — no input yet.
    expect(screen.getByText(/fires:/i).textContent).toMatch(/fires:\s*0/);
    // 3. Empty state visible.
    expect(screen.getByText(/No PTY events have fired yet/i)).toBeInTheDocument();

    // ── Feed input that matches the watcher pattern. ────────────────────────
    pty.appendOutput(b64('Wrote plan to /Users/x/.claude/plans/sample-plan.md ok\n'));

    // 4. Fires count flips to 1, empty state disappears, row appears.
    await waitFor(() => {
      expect(screen.getByText(/fires:/i).textContent).toMatch(/fires:\s*1/);
    });
    expect(screen.queryByText(/No PTY events have fired yet/i)).not.toBeInTheDocument();
    // The row carries the trigger's label.
    expect(screen.getByText('plan-detection')).toBeInTheDocument();
    // The row's matched-line cell contains the input text.
    expect(screen.getByText(/sample-plan\.md/)).toBeInTheDocument();

    // 5. Watcher counter is still 1 (no new triggers registered).
    expect(screen.getByText(/registered watchers:/i).textContent).toMatch(/registered watchers:\s*1/);

    // 6. Feed another match — counter increments.
    pty.appendOutput(b64('And later /tmp/plan-beta.md happened\n'));
    await waitFor(() => {
      expect(screen.getByText(/fires:/i).textContent).toMatch(/fires:\s*2/);
    });
    // Both rows now visible.
    expect(screen.getAllByText('plan-detection').length).toBe(2);
  });

  it('catches up on chunks fed BEFORE the trigger registers (post-replay race)', async () => {
    const pty = new PtyConnection('test-shell-abcdefgh', 'test-node');
    (pty as unknown as { _attached: boolean })._attached = true;

    // Feed lines BEFORE registering — simulates reload race where chunks
    // arrive via replay before the InteractiveTerminal's useEffect calls
    // shell.addTrigger().
    pty.appendOutput(b64('banner\n'), 1);
    pty.appendOutput(b64('Wrote plan-alpha.md\n'), 2);
    pty.appendOutput(b64('Wrote plan-beta.md\n'), 3);

    const shell = makeShellLike(pty, 'test-shell-abcdefgh');
    shell.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      label: 'plan-detection',
      onMatch: () => {},
    });

    render(<PTYEventsViewer open={true} onClose={() => {}} shell={shell} />);

    // Catchup synthesizes 2 fires retroactively — visible in the UI.
    await waitFor(() => {
      expect(screen.getByText(/fires:/i).textContent).toMatch(/fires:\s*2/);
    });
    expect(screen.getByText(/registered watchers:/i).textContent).toMatch(/registered watchers:\s*1/);
    expect(screen.getAllByText('plan-detection').length).toBe(2);
    expect(screen.getByText(/plan-alpha\.md/)).toBeInTheDocument();
    expect(screen.getByText(/plan-beta\.md/)).toBeInTheDocument();
  });

  it('built-in close X button is the only X close affordance in the header', async () => {
    const pty = new PtyConnection('test-shell-close', 'test-node');
    (pty as unknown as { _attached: boolean })._attached = true;
    const shell = makeShellLike(pty, 'test-shell-close');

    let open = true;
    const { rerender } = render(
      <PTYEventsViewer open={open} onClose={() => { open = false; }} shell={shell} />,
    );

    // Find buttons containing an X icon (lucide-x SVG class).
    const dialog = screen.getByRole('dialog');
    const xButtons = Array.from(dialog.querySelectorAll('button'))
      .filter((b) => b.querySelector('svg.lucide-x'));
    // Exactly ONE X close button (the shadcn DialogContent built-in). The
    // detail panel has its own X but is only visible when a fire is selected,
    // and we have no fires to select here.
    expect(xButtons.length).toBe(1);
    // The shadcn close button has screen-reader text "Close".
    expect(xButtons[0].textContent).toContain('Close');

    // Clicking it triggers onOpenChange(false) → onClose.
    const user = userEvent.setup();
    await user.click(xButtons[0]);
    rerender(<PTYEventsViewer open={open} onClose={() => {}} shell={shell} />);
    expect(open).toBe(false);
  });
});
