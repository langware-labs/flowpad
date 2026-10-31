import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkerModelTier } from '@sdk';
import { VibeModelSelect } from '@src/pages/flow-page/vibe-model-select';

describe('VibeModelSelect sizes', () => {
  // jsdom lacks the pointer APIs Radix Select reads when it opens.
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it('does not offer a size the budget does not have', async () => {
    const user = userEvent.setup();

    render(<VibeModelSelect value={WorkerModelTier.MD} onChange={vi.fn()} availableSizes={['md']} />);
    await user.click(screen.getByTestId('vibe-model-select'));

    expect((await screen.findByTestId('vibe-model-option-lg')).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('vibe-model-option-sm').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('vibe-model-option-md').getAttribute('aria-disabled')).not.toBe('true');
  });

  it("holds nothing back when the budget's sizes are not known", async () => {
    const user = userEvent.setup();

    render(<VibeModelSelect value={WorkerModelTier.MD} onChange={vi.fn()} availableSizes={null} />);
    await user.click(screen.getByTestId('vibe-model-select'));

    expect((await screen.findByTestId('vibe-model-option-lg')).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('shows the size an agent requires and does not let the person leave it', () => {
    render(<VibeModelSelect value={WorkerModelTier.SM} onChange={vi.fn()} pinnedSize={WorkerModelTier.LG} />);

    const trigger = screen.getByTestId('vibe-model-select');
    expect(trigger.textContent).toContain('Accurate');
    expect(trigger.disabled).toBe(true);
  });
});
