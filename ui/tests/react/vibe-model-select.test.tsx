import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkerModelTier } from '@sdk';
import { normalizeVibeModelTier, VIBE_MODEL_DEFAULT, VibeModelSelect } from '@src/pages/flow-page/vibe-model-select';

describe('VibeModelSelect', () => {
  it('shows Endpoint default without an explicit model', () => {
    render(<VibeModelSelect value={undefined} onChange={vi.fn()} />);

    expect(screen.getByTestId('vibe-model-select')).toHaveTextContent('Endpoint default');
    expect(screen.getByTestId('vibe-model-select')).toHaveTextContent('Model');
    expect(normalizeVibeModelTier(undefined)).toBe(VIBE_MODEL_DEFAULT);
  });

  it('clears an explicit concrete model without serializing the UI option', async () => {
    const onChange = vi.fn();
    render(<VibeModelSelect value="provider/exact-model" onChange={onChange} />);
    expect(screen.getByTestId('vibe-model-select')).toHaveTextContent('provider/exact-model');
    await userEvent.click(screen.getByTestId('vibe-model-select'));
    await userEvent.click(await screen.findByTestId('vibe-model-option-default'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('emits portable worker model tiers', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<VibeModelSelect value={WorkerModelTier.MD} onChange={onChange} />);
    await user.click(screen.getByTestId('vibe-model-select'));
    await user.click(await screen.findByTestId('vibe-model-option-lg'));

    expect(onChange).toHaveBeenCalledWith(WorkerModelTier.LG);
  });

  it('maps old simple Claude aliases back to tiers for display', () => {
    expect(normalizeVibeModelTier('haiku')).toBe(WorkerModelTier.SM);
    expect(normalizeVibeModelTier('sonnet')).toBe(WorkerModelTier.MD);
    expect(normalizeVibeModelTier('opus')).toBe(WorkerModelTier.LG);
  });
});
