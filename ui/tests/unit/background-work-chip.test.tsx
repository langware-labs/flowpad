import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundWorkChip } from '@src/components/entity-execution-panel/BackgroundWorkChip';

const processWith = (background_work: boolean, stopBackground = vi.fn().mockResolvedValue(undefined)) =>
  ({ background_work, stopBackground }) as never;

describe('BackgroundWorkChip', () => {
  afterEach(cleanup);

  it('is absent unless the agent left work running in the background', () => {
    const { container, rerender } = render(<BackgroundWorkChip process={processWith(false)} />);
    expect(container.innerHTML).toBe('');
    rerender(<BackgroundWorkChip process={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('offers the stop only behind a second click, and ends the work when asked', async () => {
    const stopBackground = vi.fn().mockResolvedValue(undefined);
    render(<BackgroundWorkChip process={processWith(true, stopBackground)} />);

    expect(screen.getByTestId('background-work-chip')).toBeTruthy();
    expect(screen.queryByTestId('background-work-stop')).toBeNull();
    expect(stopBackground).not.toHaveBeenCalled(); // seeing the chip must never stop anything

    fireEvent.click(screen.getByTestId('background-work-chip'));
    fireEvent.click(await screen.findByTestId('background-work-stop'));

    await waitFor(() => expect(stopBackground).toHaveBeenCalledTimes(1));
  });
});
