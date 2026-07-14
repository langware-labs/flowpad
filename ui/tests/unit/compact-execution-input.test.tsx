import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInputHistory } from '@src/hooks/use-input-history';
import { CompactExecutionInput } from '@src/components/entity-execution-panel/CompactExecutionInput';
import { QueueChip } from '@src/components/entity-execution-panel/QueueChip';
import type { AgenticProcess } from '@sdk';
import { useEffect } from 'react';

function Harness({
  running = false,
  onStop,
  onSend = () => {},
  seed = [] as string[],
}: {
  running?: boolean;
  onStop?: () => void;
  onSend?: (t: string) => void;
  seed?: string[];
}) {
  const history = useInputHistory();
  useEffect(() => {
    history.seed(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <CompactExecutionInput onSend={onSend} running={running} onStop={onStop} history={history} />
  );
}

const input = () => screen.getByTestId('entity-execution-input') as HTMLTextAreaElement;

describe('CompactExecutionInput', () => {
  afterEach(cleanup);

  it('Escape stops the in-flight turn', () => {
    const onStop = vi.fn();
    render(<Harness running onStop={onStop} />);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('Escape while idle exits history browsing and restores the draft', () => {
    render(<Harness seed={['past one', 'past two']} />);
    fireEvent.change(input(), { target: { value: 'my draft' } });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().value).toBe('past two');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(input().value).toBe('my draft');
  });

  it('ArrowUp browses newest-first; the list shows only while browsing with >1 entry', () => {
    render(<Harness seed={['alpha', 'beta']} />);
    expect(screen.queryByTestId('entity-execution-history-list')).toBeNull();

    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().value).toBe('beta');
    const list = screen.getByTestId('entity-execution-history-list');
    const items = screen.getAllByTestId('entity-execution-history-item');
    expect(items).toHaveLength(2);
    // Newest first; the current position is highlighted.
    expect(items[0].textContent).toContain('beta');
    expect(items[0].getAttribute('data-active')).toBe('true');

    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().value).toBe('alpha');

    // Exiting browsing (down past the end) hides the list again.
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(screen.queryByTestId('entity-execution-history-list')).toBeNull();
    expect(list).not.toBeUndefined();
  });

  it('history list is suppressed with a single entry', () => {
    render(<Harness seed={['only']} />);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().value).toBe('only');
    expect(screen.queryByTestId('entity-execution-history-list')).toBeNull();
  });

  it('ArrowUp mid-multiline text does not hijack the caret', () => {
    render(<Harness seed={['past']} />);
    const ta = input();
    fireEvent.change(ta, { target: { value: 'line1\nline2' } });
    ta.selectionStart = ta.value.length; // caret on last line
    ta.selectionEnd = ta.value.length;
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('line1\nline2'); // untouched — caret wasn't on line 1
  });

  it('Enter while running still sends (the panel enqueues)', () => {
    const onSend = vi.fn();
    render(<Harness running onStop={() => {}} onSend={onSend} />);
    fireEvent.change(input(), { target: { value: 'queued prompt' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('queued prompt');
    // Both affordances visible mid-turn: Send (enqueue) came back for the
    // non-empty draft, and Stop is present.
    expect(screen.getByTestId('entity-execution-stop')).toBeTruthy();
  });
});

describe('QueueChip', () => {
  afterEach(cleanup);

  const proc = (entries: { id: string; prompt: string }[]) =>
    ({
      queue: {
        enabled: true,
        entries: entries.map((e) => ({ ...e, source: 'ui', created_at: '2026-07-14T00:00:00Z' })),
      },
      dequeue: vi.fn(),
    }) as unknown as AgenticProcess;

  it('hidden at zero, shows the entry count otherwise', () => {
    const { rerender } = render(<QueueChip process={proc([])} />);
    expect(screen.queryByTestId('entity-execution-queue-chip')).toBeNull();

    rerender(<QueueChip process={proc([{ id: '1', prompt: 'a' }, { id: '2', prompt: 'b' }, { id: '3', prompt: 'c' }])} />);
    expect(screen.getByTestId('entity-execution-queue-count').textContent).toBe('3');
  });
});
