import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInputHistory } from '@src/hooks/use-input-history';
import { CompactExecutionInput } from '@src/components/entity-execution-panel/CompactExecutionInput';
import { resetComposerDrafts } from '@src/components/entity-execution-panel/composer-drafts';
import { QueueChip } from '@src/components/entity-execution-panel/QueueChip';
import type { AgenticProcess } from '@sdk';
import { useEffect } from 'react';

function Harness({
  running = false,
  onStop,
  onSend = () => {},
  seed = [] as string[],
  allowAttachments = false,
  saveDraft,
  draftScope,
}: {
  running?: boolean;
  onStop?: () => void;
  onSend?: (t: string, files?: File[]) => void;
  seed?: string[];
  allowAttachments?: boolean;
  saveDraft?: boolean;
  draftScope?: string;
}) {
  const history = useInputHistory();
  useEffect(() => {
    history.seed(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <CompactExecutionInput
      onSend={onSend}
      running={running}
      onStop={onStop}
      history={history}
      allowAttachments={allowAttachments}
      saveDraft={saveDraft}
      draftScope={draftScope}
    />
  );
}

const input = () => screen.getByTestId('entity-execution-input');

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
    expect(onSend).toHaveBeenCalledWith('queued prompt', []);
    // Both affordances visible mid-turn: Send (enqueue) came back for the
    // non-empty draft, and Stop is present.
    expect(screen.getByTestId('entity-execution-stop')).toBeTruthy();
  });
});

describe('CompactExecutionInput attachments', () => {
  afterEach(cleanup);

  const pickFile = (name = 'notes.txt') => {
    const file = new File(['hello'], name, { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('entity-execution-attach-input'), { target: { files: [file] } });
    return file;
  };

  it('the "+" picker is absent by default and present when opted in', () => {
    const { rerender } = render(<Harness />);
    expect(screen.queryByTestId('entity-execution-attach')).toBeNull();
    rerender(<Harness allowAttachments />);
    expect(screen.getByTestId('entity-execution-attach')).toBeTruthy();
  });

  it('picked files render as removable chips', () => {
    render(<Harness allowAttachments />);
    pickFile();
    expect(screen.getByText('notes.txt')).toBeTruthy();
    fireEvent.click(screen.getByText('notes.txt').closest('li')!.querySelector('button')!);
    expect(screen.queryByText('notes.txt')).toBeNull();
  });

  it('send hands the files to onSend and clears the chips; files-only send works', () => {
    const onSend = vi.fn();
    render(<Harness allowAttachments onSend={onSend} />);
    const file = pickFile();
    // No text typed — the Send button is enabled by the pending file alone.
    fireEvent.mouseDown(screen.getByTestId('entity-execution-send'));
    expect(onSend).toHaveBeenCalledWith('', [file]);
    expect(screen.queryByText('notes.txt')).toBeNull();
  });

  it('text-only send passes an empty files list', () => {
    const onSend = vi.fn();
    render(<Harness allowAttachments onSend={onSend} />);
    fireEvent.change(input(), { target: { value: 'hi' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hi', []);
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

// FLOWPAD-2035: navigating away unmounts the composer, so an unsent prompt has
// to outlive the mount — and a reload, which runs no unmount cleanup at all.
// sessionStorage: per tab, survives F5, gone when the window closes.
describe('CompactExecutionInput drafts', () => {
  beforeEach(resetComposerDrafts);
  afterEach(() => {
    cleanup();
    resetComposerDrafts();
  });

  it('the draft is stored as it is typed, so a reload finds it', () => {
    // A reload never unmounts, so a draft only saved on the way out would be
    // gone. Assert it is already in storage while the composer is still up.
    render(<Harness draftScope="chat-a" />);
    fireEvent.change(input(), { target: { value: 'typed, not sent' } });
    expect(sessionStorage.getItem('flowpad.composer.draft.chat-a')).toBe('typed, not sent');
  });

  it('an unsent draft survives unmount and comes back on remount', () => {
    const first = render(<Harness draftScope="chat-a" />);
    fireEvent.change(input(), { target: { value: 'half a thought' } });
    first.unmount();

    render(<Harness draftScope="chat-a" />);
    expect(input().value).toBe('half a thought');
  });

  it('a draft never surfaces in another conversation', () => {
    const first = render(<Harness draftScope="chat-a" />);
    fireEvent.change(input(), { target: { value: 'deploy to prod' } });
    first.unmount();

    render(<Harness draftScope="chat-b" />);
    expect(input().value).toBe('');
  });

  it('sending clears the draft, so returning finds an empty composer', () => {
    const onSend = vi.fn();
    const first = render(<Harness draftScope="chat-a" onSend={onSend} />);
    fireEvent.change(input(), { target: { value: 'sent prompt' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('sent prompt', []);
    first.unmount();

    render(<Harness draftScope="chat-a" />);
    expect(input().value).toBe('');
  });

  it('re-pointing a mounted composer swaps drafts both ways', () => {
    const { rerender } = render(<Harness draftScope="chat-a" />);
    fireEvent.change(input(), { target: { value: 'for A' } });

    rerender(<Harness draftScope="chat-b" />);
    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: 'for B' } });

    rerender(<Harness draftScope="chat-a" />);
    expect(input().value).toBe('for A');
    rerender(<Harness draftScope="chat-b" />);
    expect(input().value).toBe('for B');
  });

  it('saveDraft={false} opts out', () => {
    const first = render(<Harness draftScope="chat-a" saveDraft={false} />);
    fireEvent.change(input(), { target: { value: 'not kept' } });
    first.unmount();

    render(<Harness draftScope="chat-a" saveDraft={false} />);
    expect(input().value).toBe('');
  });

  it('without a scope nothing is stored, so composers cannot share one draft', () => {
    const first = render(<Harness />);
    fireEvent.change(input(), { target: { value: 'scopeless' } });
    first.unmount();

    render(<Harness />);
    expect(input().value).toBe('');
  });
});
