/**
 * ConversationSearchOverlay — clicking a hit opens it IN CONTEXT.
 *
 * The hit list is one truncated line per match, which is enough to recognise a
 * match but not to read it. Clicking expands the matched message together with
 * the couple of messages either side of it, so the answer can be read without
 * leaving the terminal. This drives the real overlay + the real
 * `contextWindowFor`; only the stream source is mocked, so the corpus is fixed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FlowData, FlowElementTypes } from '@sdk';

/** Built inside `vi.hoisted` so the hoisted `vi.mock` factory can close over it. */
const stream = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock('@src/hooks/use-agentic-process-stream', () => ({
  useAgenticProcessStream: () => stream.items,
}));

import { ConversationSearchOverlay } from '@src/components/terminal/interactive-terminal/ConversationSearchOverlay';

function prose(elementType: string, text: string, attrs: Record<string, string> = {}): FlowData {
  return new FlowData(elementType as never, text, { 'data-type': 'string', t: '1', ...attrs });
}

/** A conversation whose match sits in the middle, with readable neighbours. */
function conversation(): FlowData[] {
  return [
    prose(FlowElementTypes.USER_MESSAGE, 'far-earlier-question', { role: 'user' }),
    prose(FlowElementTypes.CHAT, 'before-two-answer'),
    prose(FlowElementTypes.CHAT, 'before-one-answer'),
    prose(FlowElementTypes.CHAT, 'the ZEBRAMARKER answer body'),
    prose(FlowElementTypes.CHAT, 'after-one-answer'),
    prose(FlowElementTypes.CHAT, 'after-two-answer'),
    prose(FlowElementTypes.CHAT, 'far-later-answer'),
  ];
}

function renderOverlay(items: FlowData[]) {
  stream.items = items;
  const process = { worker_type: 'claude_code', loadHistory: () => Promise.resolve() };
  return render(<ConversationSearchOverlay process={process as never} onClose={() => {}} />);
}

async function search(term: string) {
  await userEvent.type(screen.getByTestId('conversation-search-input'), term);
}

// The unit tier has no RTL auto-cleanup, so each render is unmounted here.
afterEach(cleanup);

describe('ConversationSearchOverlay — text that arrives after the row exists', () => {
  /**
   * The stream emits 'data' only when a streaming group OPENS; every later
   * frame is `appendContent`, which mutates the row in place and emits CHUNK on
   * the instance alone. `items` keeps its identity throughout, so nothing
   * downstream re-renders unless the row itself is subscribed to.
   */
  it('finds text appended to the LAST row after the search is open', async () => {
    const opening = prose(FlowElementTypes.CHAT, 'the answer begins');
    renderOverlay([prose(FlowElementTypes.USER_MESSAGE, 'a question', { role: 'user' }), opening]);
    await search('ZEBRAMARKER');
    expect(screen.queryAllByTestId('conversation-search-result')).toHaveLength(0);

    act(() => opening.appendContent(' and then ZEBRAMARKER lands'));

    await waitFor(() => expect(screen.getAllByTestId('conversation-search-result')).toHaveLength(1));
  });

  it('finds text appended to a row that is NO LONGER last', async () => {
    // The regression: an assistant message opens, a tool call lands after it,
    // and the answer keeps growing from the middle of the array. Subscribing to
    // the tail alone missed every frame after that point.
    const opening = prose(FlowElementTypes.CHAT, 'the answer begins');
    const toolCallAfter = prose(FlowElementTypes.TOOL_RESULT, 'a tool ran meanwhile');
    renderOverlay([opening, toolCallAfter]);
    await search('ZEBRAMARKER');
    expect(screen.queryAllByTestId('conversation-search-result')).toHaveLength(0);

    act(() => opening.appendContent(' and then ZEBRAMARKER lands'));

    await waitFor(() => expect(screen.getAllByTestId('conversation-search-result')).toHaveLength(1));
    expect(screen.getByTestId('conversation-search-result').textContent).toContain('ZEBRAMARKER');
  });

  it('keeps the hit count in step with several appends', async () => {
    const opening = prose(FlowElementTypes.CHAT, 'start');
    renderOverlay([opening, prose(FlowElementTypes.TOOL_RESULT, 'tool output')]);
    await search('ZEBRAMARKER');

    act(() => opening.appendContent(' ZEBRAMARKER one'));
    await waitFor(() => expect(screen.getAllByTestId('conversation-search-result')).toHaveLength(1));

    act(() => opening.appendContent(' ZEBRAMARKER two'));
    await waitFor(() => expect(screen.getAllByTestId('conversation-search-result')).toHaveLength(2));
  });
});

describe('ConversationSearchOverlay — expanding a hit', () => {
  it('shows no context until a hit is clicked', async () => {
    renderOverlay(conversation());
    await search('ZEBRAMARKER');

    expect(screen.getAllByTestId('conversation-search-result')).toHaveLength(1);
    expect(screen.queryByTestId('conversation-search-context')).toBeNull();
  });

  it('renders the matched message with two neighbours on each side', async () => {
    renderOverlay(conversation());
    await search('ZEBRAMARKER');
    await userEvent.click(screen.getByTestId('conversation-search-result'));

    const context = screen.getByTestId('conversation-search-context');
    expect(within(context).getByText(/before-two-answer/)).toBeTruthy();
    expect(within(context).getByText(/before-one-answer/)).toBeTruthy();
    expect(within(context).getByText(/ZEBRAMARKER/)).toBeTruthy();
    expect(within(context).getByText(/after-one-answer/)).toBeTruthy();
    expect(within(context).getByText(/after-two-answer/)).toBeTruthy();

    // Bounded, not the whole conversation.
    expect(within(context).queryByText(/far-earlier-question/)).toBeNull();
    expect(within(context).queryByText(/far-later-answer/)).toBeNull();
  });

  it('distinguishes the match from its surroundings', async () => {
    renderOverlay(conversation());
    await search('ZEBRAMARKER');
    await userEvent.click(screen.getByTestId('conversation-search-result'));

    const match = screen.getByTestId('conversation-search-context-match');
    expect(within(match).getByText(/ZEBRAMARKER/)).toBeTruthy();
    expect(screen.getAllByTestId('conversation-search-context-nearby')).toHaveLength(4);
  });

  it('clicking the open hit again collapses it', async () => {
    renderOverlay(conversation());
    await search('ZEBRAMARKER');
    const row = screen.getByTestId('conversation-search-result');

    await userEvent.click(row);
    expect(screen.queryByTestId('conversation-search-context')).not.toBeNull();
    await userEvent.click(row);
    expect(screen.queryByTestId('conversation-search-context')).toBeNull();
  });

  it('opens only one hit at a time', async () => {
    renderOverlay([
      prose(FlowElementTypes.CHAT, 'first ZEBRAMARKER row'),
      prose(FlowElementTypes.CHAT, 'middle filler'),
      prose(FlowElementTypes.CHAT, 'second ZEBRAMARKER row'),
    ]);
    await search('ZEBRAMARKER');

    const rows = screen.getAllByTestId('conversation-search-result');
    expect(rows).toHaveLength(2);

    await userEvent.click(rows[0]);
    let context = screen.getByTestId('conversation-search-context');
    expect(within(context).getByText(/first ZEBRAMARKER row/)).toBeTruthy();

    await userEvent.click(rows[1]);
    expect(screen.getAllByTestId('conversation-search-context')).toHaveLength(1);
    context = screen.getByTestId('conversation-search-context');
    expect(within(context).getByText(/second ZEBRAMARKER row/)).toBeTruthy();
  });

  it('changing the query closes the open context', async () => {
    renderOverlay(conversation());
    await search('ZEBRAMARKER');
    await userEvent.click(screen.getByTestId('conversation-search-result'));
    expect(screen.queryByTestId('conversation-search-context')).not.toBeNull();

    await search('X');
    expect(screen.queryByTestId('conversation-search-context')).toBeNull();
  });
});
