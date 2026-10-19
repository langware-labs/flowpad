/**
 * The LLM setup question (`/dock/llm-setup`), in the order it asks.
 *
 * A small popup asks "what should issue your LLM calls?" with "Choose a source" (left) and "Skip
 * for now" (right). The keys dialog opens ONLY from the first; nothing opens on arrival; and the
 * view carries on (back to the wizard) on a Skip or once a source is in place.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  skip: vi.fn(() => Promise.resolve()),
  goBack: vi.fn(),
  goHome: vi.fn(),
  status: null as unknown,
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, llmSourcesService: { skip: h.skip } };
});
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { goBack: h.goBack, goHome: h.goHome }, windowMode: false }),
}));
vi.mock('@src/navigation/history-position-store', () => ({ getHistoryPosition: () => ({ canGoBack: true }) }));
vi.mock('@src/components/llm-sources/use-llm-sources', () => ({
  useLlmSources: () => ({ status: h.status }),
  useFundingFollowsLogin: () => undefined,
  useFundingFollowsHubLogin: () => undefined,
}));

import { useHarnessLoginStore } from '@src/components/harness-login/harness-login-store';
import { LlmSetupView } from '@src/components/llm-setup/LlmSetupView';

// The backend's set-up verdict (`default`) is what the chooser reads.
const FUNDED = {
  resolved: { 'harness.claude.cli': { name: 'FlowPad' } },
  default: { kind: 'harness.claude.cli', installed: true, source: { name: 'FlowPad' }, reason: '' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.status = null;
  act(() => useHarnessLoginStore.getState().setOpen(false));
});
afterEach(cleanup);

describe('LlmSetupView', () => {
  it('asks the question in a small popup, with the keys dialog CLOSED', () => {
    render(<LlmSetupView />);
    expect(screen.getByTestId('llm-setup-popup')).toBeTruthy();
    expect(useHarnessLoginStore.getState().open).toBe(false);
  });

  it('offers "Choose a source" first and "Skip for now" after it', () => {
    render(<LlmSetupView />);
    const buttons = screen.getByTestId('llm-setup-popup').querySelectorAll('button');
    expect([...buttons].map((b) => b.getAttribute('data-testid'))).toEqual(['llm-setup-reopen', 'llm-setup-skip']);
  });

  it('opens the keys dialog only when "Choose a source" is pressed, and the question steps aside', () => {
    render(<LlmSetupView />);
    fireEvent.click(screen.getByTestId('llm-setup-reopen'));
    expect(useHarnessLoginStore.getState().open).toBe(true);
    expect(screen.queryByTestId('llm-setup-popup')).toBeNull();
  });

  it('Skip answers the waiting command and goes back, without ever opening the keys dialog', async () => {
    render(<LlmSetupView />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('llm-setup-skip'));
      await Promise.resolve();
    });
    expect(h.skip).toHaveBeenCalledTimes(1);
    expect(h.goBack).toHaveBeenCalledTimes(1);
    expect(useHarnessLoginStore.getState().open).toBe(false);
  });

  it('closing the keys dialog with nothing chosen returns to the question — it is not a Skip', () => {
    render(<LlmSetupView />);
    fireEvent.click(screen.getByTestId('llm-setup-reopen'));
    act(() => useHarnessLoginStore.getState().setOpen(false));
    expect(screen.getByTestId('llm-setup-popup')).toBeTruthy();
    expect(h.skip).not.toHaveBeenCalled();
    expect(h.goBack).not.toHaveBeenCalled();
  });

  it('carries on by itself once a source is in place, without a Skip', () => {
    h.status = FUNDED;
    render(<LlmSetupView />);
    expect(h.goBack).toHaveBeenCalledTimes(1);
    expect(h.skip).not.toHaveBeenCalled();
  });
});
