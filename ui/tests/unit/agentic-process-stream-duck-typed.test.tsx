import { AgenticProcess, FlowDataStream } from '@sdk';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `useAgenticProcessStream` reads a stream and nothing else, so it has always
 * accepted a duck-typed `{ flowDataStream }` — the render-budget tests in the
 * react tier drive it that way to render 1,010 frames without standing up a
 * process.
 *
 * FLOWPAD-2038 hung `useHistoryLoadAlert` off it, which subscribes with
 * `process.on(...)`. A stand-in has no `on`, so mounting threw
 * `TypeError: process.on is not a function` out of the effect and React tore the
 * whole tree down. It reached CI because the tier that covers that shape (react)
 * refuses to run without a live disposable backend, so nobody sees it locally.
 *
 * This lives in the unit tier deliberately: it needs no backend, so the contract
 * is checked by the suite everyone actually runs.
 */

function Harness({ process }: { process: AgenticProcess }) {
  const items = useAgenticProcessStream(process);
  return <div data-testid="count">{items.length}</div>;
}

describe('useAgenticProcessStream accepts a stream-only stand-in', () => {
  afterEach(cleanup);

  it('mounts with a duck-typed { flowDataStream } and does not throw', () => {
    const stream = new FlowDataStream('duck-typed-stand-in');
    const standIn = { flowDataStream: stream } as unknown as AgenticProcess;

    // The regression: this render threw `process.on is not a function`.
    const { getByTestId } = render(<Harness process={standIn} />);

    expect(getByTestId('count').textContent).toBe('0');
  });

  it('mounts with null', () => {
    const { getByTestId } = render(<Harness process={null as unknown as AgenticProcess} />);
    expect(getByTestId('count').textContent).toBe('0');
  });
});
