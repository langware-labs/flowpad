/**
 * The project list's OS-terminal launcher bar — the "run it outside" glyphs on
 * a project row's hover tip.
 *
 * What matters here is that it stays a MESSENGER. The commands are the
 * backend's, rendered from the vendors' real `AgentOptions`; the moment this
 * bar composes, trims or re-quotes one, it stops being the command we actually
 * run and the whole debug affordance is a lie. So these pin the pass-through,
 * the `cd`-once contract, and the states where it must show nothing.
 */
import { ProjectLaunchBar } from '@src/components/terminal/project-launch-bar';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminal = vi.fn<(nodeId: string, command: string) => Promise<null>>(() => Promise.resolve(null));
const launchCommands = vi.fn<(nodeId: string, cwd: string) => Promise<{ key: string; command: string }[]>>(() =>
  Promise.resolve([
    { key: 'claude_code', command: "cd '/p' && CLAUDE_PROJECT_DIR='/p' claude --dangerously-skip-permissions" },
    { key: 'opencode', command: "cd '/p' && opencode --auto '/p'" },
    { key: 'shell', command: "cd '/p'" },
  ]),
);

// Spread the real SDK: the glyph table this bar reads pulls entity/icon
// machinery out of it, so a bare two-key mock leaves the component unmountable.
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openTerminalFromComputeNode: (nodeId: string, command: string) => openTerminal(nodeId, command),
  workerLaunchCommandsFromComputeNode: (nodeId: string, cwd: string) => launchCommands(nodeId, cwd),
}));

let computeNode: { id: string } | null = { id: 'node-1' };
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ computeNode }) }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn() } }));

beforeEach(() => {
  computeNode = { id: 'node-1' };
  openTerminal.mockClear();
  launchCommands.mockClear();
});

describe('project launch bar', () => {
  it('hands the backend command straight to the OS terminal, cd and all', async () => {
    render(<ProjectLaunchBar projectPath="/p" />);
    const claude = await screen.findByTestId('project-launch-claude_code');

    await userEvent.click(claude);

    // Verbatim, and with NO `cwd` argument: the rendered line already carries
    // its own `cd`, quoted for that platform's shell, so passing the folder
    // again would `cd` twice.
    expect(openTerminal).toHaveBeenCalledWith(
      'node-1',
      "cd '/p' && CLAUDE_PROJECT_DIR='/p' claude --dangerously-skip-permissions",
    );
    expect(openTerminal.mock.calls[0]).toHaveLength(2);
  });

  it('draws one glyph per row the backend sent, in its order', async () => {
    render(<ProjectLaunchBar projectPath="/p" />);
    await screen.findByTestId('project-launch-claude_code');

    // The vendor list is the BACKEND's (it enumerates the one VENDORS table);
    // a fifth harness must appear here without this component learning its name.
    const keys = Array.from(screen.getByTestId('project-launch-bar').children).map((el) =>
      el.getAttribute('data-testid')?.replace('project-launch-', ''),
    );
    expect(keys).toEqual(['claude_code', 'opencode', 'shell']);
  });

  it('puts the exact command on every glyph — it is the thing being debugged', async () => {
    render(<ProjectLaunchBar projectPath="/p" />);
    const shell = await screen.findByTestId('project-launch-shell');

    expect(shell.getAttribute('title')).toContain("cd '/p'");
  });

  it('asks again when the folder changes — commands are per-folder', async () => {
    const { rerender } = render(<ProjectLaunchBar projectPath="/p" />);
    await screen.findByTestId('project-launch-shell');

    rerender(<ProjectLaunchBar projectPath="/other" />);

    await waitFor(() => expect(launchCommands).toHaveBeenCalledTimes(2));
    expect(launchCommands.mock.calls[1]).toEqual(['node-1', '/other']);
  });

  it('renders nothing without a compute node — there is no machine to open one on', () => {
    computeNode = null;
    const { container } = render(<ProjectLaunchBar projectPath="/p" />);

    expect(container.firstChild).toBeNull();
    expect(launchCommands).not.toHaveBeenCalled();
  });

  it('says so when the commands cannot be resolved, rather than offering dead glyphs', async () => {
    launchCommands.mockImplementationOnce(() => Promise.reject(new Error('backend said no')));
    render(<ProjectLaunchBar projectPath="/p" />);

    // A glyph that launches nothing is worse than no glyph: the user would be
    // left believing a terminal opened somewhere.
    await waitFor(() => expect(screen.queryByTestId('project-launch-shell')).toBeNull());
    expect(screen.getByText(/Couldn't resolve the launch commands/)).toBeTruthy();
  });
});
