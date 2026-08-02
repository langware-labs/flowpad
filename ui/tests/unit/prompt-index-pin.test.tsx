import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PromptIndexPanel,
  type PromptEntry,
} from '@src/components/terminal/interactive-terminal/side-windows/PromptIndexPanel';
import {
  normalizePromptText,
  useLibraryPromptsForProject,
} from '@src/components/prompt-library/useLibraryPromptsForProject';
import type { AgenticProcess, Prompt } from '@sdk';

// `view-mode-context` reads the current dock, which calls `useLocation()`.
// These tests render without a Router, so stub only that hook and keep the
// rest of the module real (a full mock would drop `useDockNavigation`).
vi.mock('@src/navigation/useDockNavigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/navigation/useDockNavigation')>()),
  useCurrentDock: () => null,
}));


vi.mock('@src/components/prompt-library/useLibraryPromptsForProject', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/components/prompt-library/useLibraryPromptsForProject')>();
  return { ...actual, useLibraryPromptsForProject: vi.fn() };
});

const mockUseLibrary = vi.mocked(useLibraryPromptsForProject);

function entry(text: string): PromptEntry {
  return { absRow: null, text, time: '2026-06-05T10:00:00Z', source: 'transcript' };
}

function makeProcess() {
  const pinPrompt = vi.fn().mockResolvedValue({ promptId: 'new-id' });
  const unpinPrompt = vi.fn().mockResolvedValue(undefined);
  const process = { pinPrompt, unpinPrompt } as unknown as AgenticProcess;
  return { process, pinPrompt, unpinPrompt };
}

describe('PromptIndexPanel pin-from-history', () => {
  const refresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLibrary.mockReturnValue({ byNormalizedText: new Map(), refresh, isLoading: false });
  });
  afterEach(() => cleanup());

  it('hides the pin button when no process is provided', () => {
    render(<PromptIndexPanel prompts={[entry('hello world')]} onScrollToLine={() => {}} />);
    expect(screen.queryByTestId('prompt-index-pin')).toBeNull();
  });

  it('pins an unpinned item and refreshes the library map', async () => {
    const { process, pinPrompt } = makeProcess();
    render(
      <PromptIndexPanel
        prompts={[entry('fix the   auth flow')]}
        onScrollToLine={() => {}}
        process={process}
        projectId="proj-1"
      />,
    );
    const pin = screen.getByTestId('prompt-index-pin');
    expect(pin.getAttribute('aria-pressed')).toBe('false');

    await userEvent.click(pin);
    await waitFor(() => expect(pinPrompt).toHaveBeenCalledWith('fix the   auth flow'));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows pinned state via normalized-text match and unpins on click', async () => {
    const { process, pinPrompt, unpinPrompt } = makeProcess();
    const libPrompt = { id: 'lib-1', text: 'fix   the auth flow' } as unknown as Prompt;
    mockUseLibrary.mockReturnValue({
      byNormalizedText: new Map([[normalizePromptText(libPrompt.text!), libPrompt]]),
      refresh,
      isLoading: false,
    });

    render(
      <PromptIndexPanel
        prompts={[entry('fix the auth   flow')]} // same normalized text, different whitespace
        onScrollToLine={() => {}}
        process={process}
        projectId="proj-1"
      />,
    );
    const pin = screen.getByTestId('prompt-index-pin');
    expect(pin.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(pin);
    await waitFor(() => expect(unpinPrompt).toHaveBeenCalledWith('lib-1'));
    expect(pinPrompt).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });
});
