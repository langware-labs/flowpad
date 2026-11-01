import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentModelSizeField } from '@src/components/assets/editor/agent-profile/AgentModelSizeField';

describe('AgentModelSizeField', () => {
  // jsdom lacks the pointer APIs Radix Select reads when it opens.
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it('reads "whatever I get" when the agent names no size', () => {
    render(<AgentModelSizeField value={undefined} onCommit={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Model size' }).textContent).toContain('Whatever I get');
  });

  it('commits the size the agent requires', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(<AgentModelSizeField value={undefined} onCommit={onCommit} />);
    await user.click(screen.getByRole('combobox', { name: 'Model size' }));
    await user.click(await screen.findByTestId('agent-model-size-lg'));

    expect(onCommit).toHaveBeenCalledWith('lg');
  });

  it('commits undefined to go back to whatever the person gets', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(<AgentModelSizeField value="md" onCommit={onCommit} />);
    await user.click(screen.getByRole('combobox', { name: 'Model size' }));
    await user.click(await screen.findByTestId('agent-model-size-default'));

    expect(onCommit).toHaveBeenCalledWith(undefined);
  });

  it('keeps a model named by hand in agent.json instead of rewriting it', () => {
    render(<AgentModelSizeField value="someone/their-model-9" onCommit={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Model size' }).textContent).toContain('someone/their-model-9');
  });
});
