import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FirstAgentCard } from '@src/pages/hub-home/first-agent/FirstAgentCard';

describe('FirstAgentCard — email', () => {
  it('offers Email first, Gmail off with the support address, and × closes the wizard', async () => {
    const user = userEvent.setup();
    const onActiveChange = vi.fn();
    render(<FirstAgentCard onActiveChange={onActiveChange} />);

    const tiles = screen.getAllByTestId(/^first-agent-channel-/).map((b) => b.dataset.testid);
    expect(tiles).toEqual([
      'first-agent-channel-email',
      'first-agent-channel-slack',
      'first-agent-channel-whatsapp',
      'first-agent-channel-telegram',
    ]);
    expect(screen.queryByTestId('first-agent-close')).toBeNull();
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    await user.click(screen.getByTestId('first-agent-channel-email'));
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    await user.type(screen.getByTestId('first-agent-prompt'), 'Answer emails about our opening hours.');
    await user.click(screen.getByTestId('first-agent-next'));

    expect(screen.getByText('How should it connect to Email?')).toBeInTheDocument();
    const gmail = screen.getByTestId('first-agent-option-own_gmail');
    expect(gmail).toBeDisabled();
    expect(gmail.querySelector('a')).toHaveAttribute('href', 'mailto:support@langware.ai');
    await user.click(screen.getByTestId('first-agent-option-agent_email'));
    expect(screen.getByTestId('first-agent-create')).toHaveTextContent('Get its address');

    await user.click(screen.getByTestId('first-agent-close'));
    expect(screen.getByTestId('first-agent-channel-email')).toBeInTheDocument();
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });
});
