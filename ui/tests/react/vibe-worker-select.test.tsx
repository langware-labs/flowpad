import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { normalizeWorkerType } from '@src/components/workers/worker-types';
import { VibeWorkerSelect } from '@src/pages/flow-page/vibe-worker-select';

describe('VibeWorkerSelect', () => {
  it('shows Claude by default', () => {
    render(<VibeWorkerSelect value={undefined} onChange={vi.fn()} />);

    expect(screen.getByTestId('vibe-worker-select')).toHaveTextContent('Worker');
    expect(screen.getByTestId('vibe-worker-select')).toHaveTextContent('Claude');
    expect(normalizeWorkerType(undefined)).toBe('claude_code');
  });

  it('emits normalized worker ids', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<VibeWorkerSelect value="claude_code" onChange={onChange} />);
    await user.click(screen.getByTestId('vibe-worker-select'));
    await user.click(await screen.findByTestId('vibe-worker-option-codex'));

    expect(onChange).toHaveBeenCalledWith('codex');
  });

  it('maps old worker aliases back to launchable worker ids', () => {
    expect(normalizeWorkerType('claude')).toBe('claude_code');
    expect(normalizeWorkerType('claude_code')).toBe('claude_code');
    expect(normalizeWorkerType('codex')).toBe('codex');
    expect(normalizeWorkerType('copilot')).toBe('copilot');
  });
});
