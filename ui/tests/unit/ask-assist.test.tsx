/**
 * AI Assist on a question: the button shows only when the op names an agent, starts the assist, and
 * the form stays usable while the agent works. A failed assist reads as a tinted row (never red text
 * on black) and leaves the question to the person; a question settled while the agent worked was
 * answered by it.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), openDock: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

import { AskForm } from '@src/components/ask/AskForm';

const QUESTION = {
  id: 'q1', op: 'ask-gcp-KEY', prompt: 'Google Cloud: service-account key', fields: 'string',
  secret: true, file: true, guide: '1. Create a key.', assist_available: true, assist: null,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.get.mockReset();
  h.post.mockReset();
  h.openDock.mockReset();
});

describe('AskAssist', () => {
  it('is not offered when the op names no agent', async () => {
    h.get.mockResolvedValue({ ...QUESTION, assist_available: false });
    render(<AskForm questionId="q1" />);
    expect(await screen.findByTestId('ask-guide')).toBeInTheDocument();
    expect(screen.queryByTestId('ask-assist')).not.toBeInTheDocument();
  });

  it('starts the assist and keeps the form usable while the agent works', async () => {
    h.get.mockResolvedValue(QUESTION);
    h.post.mockResolvedValue({ state: 'running', detail: 'starting the agent', process: 'agentic_process-abc' });
    render(<AskForm questionId="q1" />);

    const start = await screen.findByTestId('ask-assist-start');
    await act(async () => fireEvent.click(start));

    expect(h.post).toHaveBeenCalledWith('/api/v1/ask/q1/assist');
    expect(screen.getByTestId('ask-assist-running')).toBeInTheDocument();
    expect(screen.getByTestId('ask-assist-start')).toBeDisabled();
    expect(screen.getByTestId('ask-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('ask-assist-process'));
    expect(h.openDock).toHaveBeenCalled();
  });

  it('shows a failed assist as a tinted row and offers another try', async () => {
    h.get.mockResolvedValue({
      ...QUESTION, assist: { state: 'failed', detail: "needs the person's Google sign-in", process: '' },
    });
    render(<AskForm questionId="q1" />);

    const failed = await screen.findByTestId('ask-assist-failed');
    expect(failed).toHaveTextContent("needs the person's Google sign-in");
    expect(failed.className).toContain('text-foreground');
    expect(screen.getByTestId('ask-assist-start')).toHaveTextContent('Try AI Assist again');
  });

  it('a question gone while the agent worked was answered by it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const settled = vi.fn();
    h.get.mockResolvedValueOnce({ ...QUESTION, assist: { state: 'running', detail: 'working', process: '' } });
    h.get.mockResolvedValue(null);
    render(<AskForm questionId="q1" onSettled={settled} />);
    expect(await screen.findByTestId('ask-assist-running')).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTime(2000));

    await waitFor(() => expect(settled).toHaveBeenCalledWith('answered'));
    expect(screen.getByTestId('ask-settled')).toHaveTextContent('AI Assist answered it.');
  });
});
