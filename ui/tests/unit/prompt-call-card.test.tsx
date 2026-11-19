import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessCall } from '@sdk';

vi.mock('@src/components/conversation/process-call', async (actual) => ({
  ...(await actual<typeof import('@src/components/conversation/process-call')>()),
  decideProcessCall: vi.fn(() => Promise.resolve()),
}));

import { PromptCallCard } from '@src/components/conversation/PromptCallCard';
import { decideProcessCall } from '@src/components/conversation/process-call';

const call = { call_id: 'c1', exe: { prompt: 'run npm ci\nand report the first error' } } as ProcessCall;
const card = (role: 'sender' | 'recipient') => (
  <PromptCallCard
    call={call}
    messageId="m1"
    conversationId="conv1"
    role={role}
    otherName="Sam"
    answer={null}
    running={false}
  />
);

describe('PromptCallCard', () => {
  afterEach(() => cleanup());

  it('the receiver reads the whole prompt in the Prompt to run window and runs it from there', async () => {
    render(card('recipient'));
    expect(screen.getByTestId('prompt-call-approve').textContent).toBe('Run');
    expect(screen.getByTestId('prompt-call-decline')).toBeTruthy();
    fireEvent.click(screen.getByTestId('prompt-call-review'));
    const window_ = await screen.findByRole('dialog');
    expect(window_.textContent).toContain('Prompt to run');
    expect(window_.querySelector('pre')?.textContent).toBe(call.exe?.prompt);
    fireEvent.click(window_.querySelector('[data-testid=prompt-call-approve]')!);
    await waitFor(() => expect(decideProcessCall).toHaveBeenCalledWith('conv1', 'm1', 'approve'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('prompt-call-card').getAttribute('data-state')).toBe('running');
  });

  it('the sender gets the status and no answers', () => {
    render(card('sender'));
    expect(screen.getByTestId('prompt-call-status').textContent).toBe('delivered · waiting for Sam to approve');
    expect(screen.queryByTestId('prompt-call-approve')).toBeNull();
    expect(screen.queryByTestId('prompt-call-review')).toBeNull();
  });
});
