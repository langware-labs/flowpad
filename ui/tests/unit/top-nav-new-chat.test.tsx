/**
 * The navigation bar's quick-launch button.
 *
 * The whole point of it is that it asks nothing, so what is worth pinning is
 * exactly the two decisions it makes on the user's behalf: the harness is the
 * LAST one used (not the capability default), and the launch goes through
 * `openNewChat` — the chain that reads the current View mode — rather than any
 * mode-pinned creation path of its own.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const openNewChat = vi.hoisted(() => vi.fn(() => Promise.resolve({ id: 'p1' })));
const openCapabilitiesForWorker = vi.hoisted(() => vi.fn());
const rememberWorker = vi.hoisted(() => vi.fn());
const lastWorker = vi.hoisted(() => ({ current: null as string | null }));

vi.mock('@src/navigation/open-new-chat', () => ({ openNewChat }));
vi.mock('@src/navigation/open-capabilities', () => ({ openCapabilitiesForWorker }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/components/terminal/openers/useLastWorkerType', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/terminal/openers/useLastWorkerType')>()),
  useLastWorkerType: () => ({ lastWorker: lastWorker.current, rememberWorker }),
}));

import { NewChatButton } from '@src/components/top-nav-bar/NewChatButton';
import { TooltipProvider } from '@src/components/ui/tooltip';

function renderButton() {
  // The app mounts one provider at the root; the bar's buttons only supply the
  // tooltip itself.
  return render(
    <TooltipProvider>
      <NewChatButton />
    </TooltipProvider>,
  );
}

describe('NewChatButton', () => {
  beforeEach(() => {
    lastWorker.current = null;
    openNewChat.mockClear();
    openCapabilitiesForWorker.mockClear();
    rememberWorker.mockClear();
    openNewChat.mockResolvedValue({ id: 'p1' });
  });
  afterEach(cleanup);

  it('launches with the last-used harness', async () => {
    lastWorker.current = 'codex';
    renderButton();
    await userEvent.click(screen.getByTestId('top-nav-new-chat'));
    expect(openNewChat).toHaveBeenCalledWith(expect.anything(), { workerType: 'codex' });
    // Re-stamped even though it was already the last pick: the button is a
    // launch surface like any other, and the key is shared with the strip.
    expect(rememberWorker).toHaveBeenCalledWith('codex');
  });

  it('falls back to the capability default before any launch has been made', async () => {
    renderButton();
    await userEvent.click(screen.getByTestId('top-nav-new-chat'));
    // No HarnessCapabilitiesProvider here, so the default resolves to the
    // fallback vendor — the presentational default, not a silent `undefined`.
    expect(openNewChat).toHaveBeenCalledWith(expect.anything(), { workerType: 'claude_code' });
  });

  it('wears the harness it will start — its vendor mark, and its name', () => {
    lastWorker.current = 'copilot';
    renderButton();
    const button = screen.getByTestId('top-nav-new-chat');
    expect(button.getAttribute('aria-label')).toBe('New Copilot chat');
    // The glyph is the vendor's own, resolved through the shared table: the
    // mark is Copilot's and so is the tint, not Claude's orange. The packs
    // render it as a mask span, which is also why the size is asserted — an
    // `svg`-only rule would silently leave it at the 1em default.
    const glyph = button.querySelector('.fp-icon');
    expect(glyph?.getAttribute('class')).toContain('text-sky-500');
    expect(glyph?.getAttribute('class')).toContain('size-[18px]');
    expect(glyph?.getAttribute('style')).toContain('copilot.svg');
  });

  it('sends a failed launch to Capabilities for that harness', async () => {
    lastWorker.current = 'opencode';
    openNewChat.mockRejectedValue(new Error('no binary'));
    renderButton();
    await userEvent.click(screen.getByTestId('top-nav-new-chat'));
    expect(openCapabilitiesForWorker).toHaveBeenCalledWith(expect.anything(), 'opencode');
  });
});
