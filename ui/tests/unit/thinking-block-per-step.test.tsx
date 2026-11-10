/**
 * FLOWPAD-2350: in a long turn the agent thinks, runs a tool, thinks again, runs
 * another tool… without writing any text in between. Each of those thoughts is
 * its own step, but the chat showed them all in ONE "Thinking" block that kept
 * growing for the whole turn.
 *
 * The fixture is real: the Claude transcript lines behind the bug report, run
 * through the backend's own converter (`session_history.entry_to_flowdata`, the
 * same one the live PTY tail and the history reload use) and saved as the JSON
 * the history endpoint ships. Tool inputs are shortened and the local user path
 * replaced; the frames, their order, ids and thinking text are as emitted.
 *
 * Both cases enter the way the chat panes do: frames go into the process's
 * `FlowDataStream`, its items feed `useTurnGroups`, and `TurnGroupsList` renders
 * them — "show tool calls" off, the default, as in the report.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowData, FlowDataStream, FlowElementTypes, PrefKey, instancePreferences } from '@sdk';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';
import { groupTurnEvents, splitLiveGroup, useTurnGroups } from '@src/components/floating-chat/groupTurnEvents';

// jsdom has no IntersectionObserver; TurnGroupsList's recent-window hook needs one.
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    disconnect() {}
  },
);

const FRAMES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'claude-multi-step-thinking-frames.json'), 'utf-8'),
) as Record<string, unknown>[];

/** One phrase from each step's thinking, in the order the agent thought them. */
const STEPS = [
  'updating the module docstring', // before the reply "Updating the parity file's description…"
  'On SQLite, all 22 tests passed', // then Bash
  'counting the test totals', // then Bash
  'The mock repository test', // then Bash, then the final reply
];

function Chat({ items }: { items: readonly FlowData[] }) {
  const groups = useTurnGroups(items as FlowData[]);
  return (
    <MemoryRouter>
      <TurnGroupsList groups={groups} />
    </MemoryRouter>
  );
}

/** Open every Thinking block and say which steps' thinking each one holds. */
function thinkingBlocks(container: HTMLElement): string[][] {
  container.querySelectorAll('[data-testid="thinking-disclosure-toggle"]').forEach((t) => fireEvent.click(t));
  return [...container.querySelectorAll('[data-testid="thinking-disclosure"]')].map((block) =>
    STEPS.filter((step) => block.textContent?.includes(step)),
  );
}

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.thinking_step_groups.rules: FAILING? read this tag's rules before
//       editing groupTurnEvents.ts - a tool row must seal the thinking before it, and
//       splitLiveGroup must merge every dense group since the last message
// flowpad:endcapsule tag
describe('FLOWPAD-2350 — one Thinking block per step', () => {
  afterEach(() => {
    cleanup();
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });

  it('a reloaded turn shows each step’s thinking in its own block', () => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
    const stream = new FlowDataStream('history');
    stream.ingestBatch(FRAMES.map((row) => FlowData.fromJSON(row)));

    const { container } = render(<Chat items={[...stream.items]} />);

    expect(thinkingBlocks(container)).toEqual(STEPS.map((step) => [step]));
  });

  it('a live turn starts a new Thinking block after each tool call', () => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
    const stream = new FlowDataStream('live');
    const { container, rerender } = render(<Chat items={[]} />);

    for (const row of FRAMES) {
      act(() => {
        stream.ingest(FlowData.fromJSON(row));
      });
      rerender(<Chat items={[...stream.items]} />);
    }

    expect(thinkingBlocks(container)).toEqual(STEPS.map((step) => [step]));
  });

  it('mid-turn, the footer chip still holds every tool call since the last message', () => {
    // The turn as it stood before its final reply: four tool calls (Edit, Bash ×3)
    // since "Updating the parity file's description…", three steps of thinking.
    const stream = new FlowDataStream('live');
    stream.ingestBatch(FRAMES.slice(0, -1).map((row) => FlowData.fromJSON(row)));

    const { inlineGroups, liveEvents } = splitLiveGroup(groupTurnEvents(stream.items), true);

    expect(liveEvents.map((e) => e.elementType)).toEqual(Array(4).fill(FlowElementTypes.TOOL_CALL));
    expect(inlineGroups.map((g) => g.kind)).toEqual(['thinking', 'message', 'thinking', 'thinking', 'thinking']);
  });
});
