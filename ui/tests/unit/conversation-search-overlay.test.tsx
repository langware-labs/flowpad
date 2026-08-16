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
import { MemoryRouter } from 'react-router';

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

/** A transcript row shaped the way the backend actually ships one, so the chip's
 *  descriptor reads the same fields here as in the chat panes. */
function replayRow(
  elementType: string,
  flowValue: unknown,
  attributes: Record<string, string>,
  index: number,
): FlowData {
  const row = FlowData.fromJSON({
    flow_value: flowValue,
    index,
    created_time: `2026-07-10T06:00:00.${String(index).padStart(3, '0')}Z`,
    attributes: { 'element-type': elementType, ...attributes },
  });
  row.markReady();
  return row;
}

function toolCall(id: string, command: string, index: number): FlowData {
  return replayRow(
    FlowElementTypes.TOOL_CALL,
    { tool_name: 'Bash', tool_use_id: id, tool_call_id: id, args: { command } },
    { 'data-type': 'object', 'tool-name': 'Bash', 'tool-use-id': id, subtype: 'tool_use' },
    index,
  );
}

function toolResult(id: string, output: string, index: number): FlowData {
  return replayRow(
    FlowElementTypes.TOOL_RESULT,
    output,
    { 'data-type': 'string', 'tool-name': 'Bash', 'tool-use-id': id },
    index,
  );
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

/** Router-wrapped: an expanded tool chip resolves its "open the thing I touched"
 *  target through `useDockNavigation`, and the overlay always renders inside the
 *  dock in the app. */
function renderOverlay(items: FlowData[]) {
  stream.items = items;
  const process = { worker_type: 'claude_code', loadHistory: () => Promise.resolve() };
  return render(
    <MemoryRouter>
      <ConversationSearchOverlay process={process as never} onClose={() => {}} />
    </MemoryRouter>,
  );
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

  it('renders a tool run as a chip, not as raw output in an assistant bubble', async () => {
    // `ExecutionMessage` has no tool branch: it markdown-renders `content` under
    // the worker's identity row, so a TOOL_RESULT used to read as the agent
    // saying its own raw stdout — and the TOOL_CALL beside it rendered as
    // nothing at all, its payload living in `data`, not `content`.
    renderOverlay([
      prose(FlowElementTypes.CHAT, 'let me run the suite'),
      toolCall('call-1', 'npm test', 1),
      toolResult('call-1', 'FAIL ZEBRAMARKER assertion failed', 2),
      prose(FlowElementTypes.CHAT, 'the suite is red'),
    ]);
    await search('ZEBRAMARKER');
    await userEvent.click(screen.getByTestId('conversation-search-result'));

    const context = screen.getByTestId('conversation-search-context');
    expect(within(context).getByTestId('dense-tool-row')).toBeTruthy();
    // The chip names the operation; the raw stdout is behind its expander.
    expect(within(context).queryByText(/assertion failed/)).toBeNull();
    // The prose either side is untouched.
    expect(within(context).getByText(/let me run the suite/)).toBeTruthy();
    expect(within(context).getByText(/the suite is red/)).toBeTruthy();
  });

  it('merges a call and its result into ONE chip', async () => {
    // Handed a lone TOOL_RESULT, `pairToolEvents` can only render the
    // "no matching call" fallback — the raw reading the chip replaces. Adjacent
    // tool rows are grouped so the call is there to pair with.
    renderOverlay([
      prose(FlowElementTypes.CHAT, 'ZEBRAMARKER before the tools'),
      toolCall('call-1', 'npm test', 1),
      toolResult('call-1', 'ok', 2),
    ]);
    await search('ZEBRAMARKER');
    await userEvent.click(screen.getByTestId('conversation-search-result'));

    const context = screen.getByTestId('conversation-search-context');
    expect(within(context).getAllByTestId('dense-tool-row')).toHaveLength(1);
  });

  it('marks the matched row when the match is in the tool run itself', async () => {
    renderOverlay([
      prose(FlowElementTypes.CHAT, 'running it'),
      toolCall('call-1', 'npm test ZEBRAMARKER', 1),
      toolResult('call-1', 'ok', 2),
      prose(FlowElementTypes.CHAT, 'done'),
    ]);
    await search('ZEBRAMARKER');
    await userEvent.click(screen.getByTestId('conversation-search-result'));

    const match = screen.getByTestId('conversation-search-context-match');
    expect(within(match).getByTestId('dense-tool-row')).toBeTruthy();
  });

  it('expanding a chip does not collapse the hit it sits in', async () => {
    renderOverlay([
      prose(FlowElementTypes.CHAT, 'ZEBRAMARKER then a tool'),
      toolCall('call-1', 'npm test', 1),
      toolResult('call-1', 'the captured output', 2),
    ]);
    await search('ZEBRAMARKER');
    await userEvent.click(screen.getByTestId('conversation-search-result'));

    await userEvent.click(screen.getByTestId('dense-tool-row-toggle'));

    expect(screen.queryByTestId('conversation-search-context')).not.toBeNull();
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
