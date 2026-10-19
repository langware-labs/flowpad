import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({
  wait: 'background' as string | null,
  process: null as unknown,
}));

vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: live.process }) }));
vi.mock('@src/components/terminal/interactive-terminal/use-process-surface', () => ({
  useSurfaceSwitchWait: () => live.wait,
}));

import { SurfaceSwitchWaitNotice } from '@src/components/terminal/interactive-terminal/SurfaceSwitchWaitNotice';

// A real process id: the notice builds a TypeId from it, which validates.
const ID = crypto.randomUUID();

const processWith = (background_work: boolean, stopBackground = vi.fn().mockResolvedValue(undefined)) =>
  ({ id: ID, background_work, stopBackground }) as never;

describe('SurfaceSwitchWaitNotice — a switch to the terminal held back by background work', () => {
  beforeEach(() => {
    live.wait = 'background';
  });
  afterEach(cleanup);

  it('offers no way out when the work is in the terminal (it ends there, the switch just waits)', () => {
    live.process = processWith(false);
    render(<SurfaceSwitchWaitNotice processId={ID} />);

    expect(screen.getByTestId('surface-switch-wait-notice')).toBeTruthy();
    expect(screen.queryByTestId('surface-switch-end-background')).toBeNull();
  });

  it('asks before ending the work, says that it ends, and does nothing on cancel', async () => {
    const stopBackground = vi.fn().mockResolvedValue(undefined);
    live.process = processWith(true, stopBackground);
    render(<SurfaceSwitchWaitNotice processId={ID} />);

    fireEvent.click(screen.getByTestId('surface-switch-end-background'));
    expect(await screen.findByText('Switching to the terminal will end the background work. Continue?')).toBeTruthy();
    expect(stopBackground).not.toHaveBeenCalled(); // asking must never stop anything

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Switch to the terminal?')).toBeNull());
    expect(stopBackground).not.toHaveBeenCalled();
  });

  it('ends the background work once confirmed — the surface retries the switch when it is gone', async () => {
    const stopBackground = vi.fn().mockResolvedValue(undefined);
    live.process = processWith(true, stopBackground);
    render(<SurfaceSwitchWaitNotice processId={ID} />);

    fireEvent.click(screen.getByTestId('surface-switch-end-background'));
    fireEvent.click(await screen.findByText('Switch and end background work'));

    await waitFor(() => expect(stopBackground).toHaveBeenCalledTimes(1));
  });

  it('shows nothing while no switch is waiting', () => {
    live.wait = null;
    live.process = processWith(true);
    const { container } = render(<SurfaceSwitchWaitNotice processId={ID} />);

    expect(container.innerHTML).toBe('');
  });
});
