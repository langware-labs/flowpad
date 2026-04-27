import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProcessStatus, WorkerStatus } from '@sdk';
import { ProcessStatusLine } from '@src/components/agentic-progress/shared/process-status-line';

/**
 * Contract exercised by this file:
 *
 *   The Open-in-Terminal button is enabled iff
 *     status == RUNNING && workerStatus ∈ {IDLE, COMPLETE, INTERRUPTED}
 *
 *   Label text comes from workerStatusConfig when running, processStatusConfig otherwise.
 */

function makeProcess(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    status: ProcessStatus.RUNNING,
    workerStatus: WorkerStatus.IDLE,
    session_id: 'sess-abc',
    visible: false,
    ...overrides,
  };
}

describe('ProcessStatusLine — labels', () => {
  it('renders the worker-status label when the process is running', () => {
    render(<ProcessStatusLine process={makeProcess({ workerStatus: WorkerStatus.THINKING })} />);
    expect(screen.getByText('Thinking')).toBeDefined();
  });

  it('renders the lifecycle label for stopped processes', () => {
    render(
      <ProcessStatusLine
        process={makeProcess({ status: ProcessStatus.STOPPED, workerStatus: WorkerStatus.COMPLETE })}
      />,
    );
    expect(screen.getByText('Complete')).toBeDefined();
  });

  it('renders secondary text when provided', () => {
    render(<ProcessStatusLine process={makeProcess()} secondary="Run 3" />);
    expect(screen.getByText('Run 3')).toBeDefined();
  });
});

describe('ProcessStatusLine — Open-in-Terminal gate', () => {
  it('is not rendered when onOpenInTerminal is absent', () => {
    render(<ProcessStatusLine process={makeProcess()} />);
    expect(screen.queryByTestId('process-status-line-open-terminal')).toBeNull();
  });

  it('is enabled when ready_for_input (RUNNING + IDLE, no session)', () => {
    render(
      <ProcessStatusLine
        process={makeProcess({ workerStatus: WorkerStatus.IDLE, session_id: null })}
        onOpenInTerminal={() => {}}
      />,
    );
    const btn = screen.getByTestId('process-status-line-open-terminal') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('is enabled when worker is COMPLETE and process is RUNNING', () => {
    render(
      <ProcessStatusLine
        process={makeProcess({ workerStatus: WorkerStatus.COMPLETE })}
        onOpenInTerminal={() => {}}
      />,
    );
    const btn = screen.getByTestId('process-status-line-open-terminal') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('is disabled while the worker is mid-turn (THINKING)', () => {
    render(
      <ProcessStatusLine
        process={makeProcess({ workerStatus: WorkerStatus.THINKING })}
        onOpenInTerminal={() => {}}
      />,
    );
    const btn = screen.getByTestId('process-status-line-open-terminal') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('is disabled when the lifecycle is not RUNNING', () => {
    render(
      <ProcessStatusLine
        process={makeProcess({ status: ProcessStatus.STARTING, workerStatus: WorkerStatus.IDLE })}
        onOpenInTerminal={() => {}}
      />,
    );
    const btn = screen.getByTestId('process-status-line-open-terminal') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('fires onOpenInTerminal when clicked', () => {
    const spy = vi.fn();
    render(
      <ProcessStatusLine
        process={makeProcess({ workerStatus: WorkerStatus.COMPLETE })}
        onOpenInTerminal={spy}
      />,
    );
    fireEvent.click(screen.getByTestId('process-status-line-open-terminal'));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
