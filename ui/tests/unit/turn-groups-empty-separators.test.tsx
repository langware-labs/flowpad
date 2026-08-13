import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FlowElementTypes, PrefKey, instancePreferences } from '@sdk';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';

/**
 * FLOWPAD-1983 — the vibe chat drew a hairline separator with no message under it.
 *
 * `TurnGroupsList` decides the separator per VISIBLE group, but whether a row
 * paints anything is decided two levels down: `ExecutionMessage` early-returns
 * `null` on blank content, and `ToolEntryRow` returns `null` for a dense group
 * with no events. Claude's history replay mints a CHAT frame with empty content
 * for every text-less assistant turn (thinking-only turns and empty text blocks),
 * so every such turn stranded a divider.
 *
 * The leaf renderers are deliberately NOT mocked here — the sibling suite
 * (turn-groups-show-tools) stubs `execution-message` to a div that always paints,
 * which is exactly what made it blind to this bug.
 */

function messageGroup(index: number, content: string, extra: Record<string, unknown> = {}): TurnGroup {
  return {
    kind: 'message',
    index,
    flowData: {
      id: `m${index}`,
      elementType: FlowElementTypes.CHAT,
      dataType: 'object',
      content,
      attributes: { role: 'assistant' },
      ...extra,
    } as never,
  };
}

function renderList(groups: TurnGroup[]) {
  const { container } = render(
    <MemoryRouter>
      <TurnGroupsList groups={groups} worker="claude_code" />
    </MemoryRouter>,
  );
  const dividers = container.querySelectorAll('div[aria-hidden="true"] > div.h-px').length;
  const rows =
    screen.queryAllByTestId('execution-message').length +
    screen.queryAllByTestId('meta-message-chip').length +
    screen.queryAllByTestId('dense-tool-row').length;
  return { dividers, rows };
}

describe('TurnGroupsList — separators only between rows that render', () => {
  beforeEach(() => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });
  afterEach(() => {
    cleanup();
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });

  it('does not draw a separator for a blank assistant turn', () => {
    // The replayed shape: a real turn, a text-less turn, a real turn. Before the
    // fix this rendered 2 rows with 2 dividers — one of them dangling.
    const { dividers, rows } = renderList([
      messageGroup(0, 'hello'),
      messageGroup(1, ''),
      messageGroup(2, 'world'),
    ]);

    expect(rows).toBe(2);
    expect(dividers).toBe(1);
  });

  it('treats a whitespace-only turn as blank', () => {
    const { dividers, rows } = renderList([messageGroup(0, 'hello'), messageGroup(1, '\n  \n'), messageGroup(2, 'world')]);

    expect(rows).toBe(2);
    expect(dividers).toBe(1);
  });

  it('keeps an in-flight (still streaming) blank turn so its chunks can land', () => {
    // `ready === false` = start tag seen, no chunk yet. Chunks consolidate in
    // place WITHOUT re-emitting the stream's 'data' event, so a frame filtered
    // out here would never come back and the reply would stay invisible.
    const groups = [messageGroup(0, 'hello'), messageGroup(1, '', { ready: false })];
    render(
      <MemoryRouter>
        <TurnGroupsList groups={groups} worker="claude_code" />
      </MemoryRouter>,
    );

    // ExecutionMessage still paints nothing while the content is empty, but the
    // group must survive the filter — the row stays mounted and subscribed.
    expect(groups.filter((g) => g.kind === 'message')).toHaveLength(2);
    expect(screen.queryAllByTestId('execution-message')).toHaveLength(1);
  });

  it('drops a dense group with no events instead of stranding its separator', () => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, true);
    // A committed dense group can be emptied by the grouper's `retract` when a
    // refinement supersedes its only event.
    const { dividers, rows } = renderList([
      messageGroup(0, 'hello'),
      { kind: 'dense', index: 1, events: [] },
      messageGroup(2, 'world'),
    ]);

    expect(rows).toBe(2);
    expect(dividers).toBe(1);
  });

  it('holds the invariant: dividers === renderedRows - 1', () => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, true);
    const { dividers, rows } = renderList([
      messageGroup(0, ''),
      messageGroup(1, 'first'),
      { kind: 'dense', index: 2, events: [] },
      messageGroup(3, '   '),
      messageGroup(4, 'second'),
      messageGroup(5, ''),
      messageGroup(6, 'third'),
    ]);

    expect(rows).toBe(3);
    expect(dividers).toBe(Math.max(0, rows - 1));
  });
});
