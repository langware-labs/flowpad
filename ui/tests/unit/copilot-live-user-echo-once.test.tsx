import { AgenticProcess, FlowElementTypes, TypeId, dataManager } from '@sdk';
import { FlowData, FlowDataAttribute } from '@sdk/flow_processing';
import { retireObservedEchoes } from '@src/hooks/retire-observed-echoes';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A Copilot turn sent from the Vibe chat rendered the user's message TWICE
 * while it ran, once after a reload.
 *
 * `prompt()` echoes the user turn optimistically (a placeholder with no
 * transcript id). Copilot's stdout echoes `user.message`, so the backend's live
 * converter (`copilot/event_to_flowdata.py`) streams a real USER_MESSAGE for
 * the same turn. The SDK retires echoes only on a history load, so both rows
 * reached the chat. Claude never hit this: its stdout does not echo the user's
 * own turn, so the echo is the only copy until the history load retires it.
 */

const PROC_ID = '5d7a3c2e-6f41-4b8e-9c1a-0e2f4b6d8a10';
const PROC_TYPEID = new TypeId(AgenticProcess.type, PROC_ID);
const PROMPT = 'Build me a Kube Guide';

/**
 * The Copilot live wire for one turn: its stdout user.message echo, then the
 * reply. Its `t` is the WORKER's clock and deliberately earlier than the
 * browser-clock echo, so the observed copy sorts BEFORE the echo in `items` —
 * pairing must follow arrival order, not render order.
 */
const COPILOT_WIRE =
  `<flow-user-message i="0" t="2026-09-27T19:01:05.334Z" data-type="string"` +
  ` subtype="user_message" observation-kind="live" role="user">${PROMPT}</flow-user-message>\n` +
  `<flow-chat i="1" t="2026-09-27T19:01:07.000Z" data-type="string"` +
  ` subtype="assistant_message" observation-kind="live" role="assistant">On it.</flow-chat>\n`;

/** Claude's live wire: stdout never echoes the user's own turn. */
const CLAUDE_WIRE =
  `<flow-chat i="0" t="2026-09-27T19:01:07.000Z" data-type="string"` +
  ` subtype="assistant_message" observation-kind="live" role="assistant">On it.</flow-chat>\n`;

function openBody() {
  let push: (chunk: string) => void = () => {};
  let close: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      push = (chunk) => controller.enqueue(enc.encode(chunk));
      close = () => controller.close();
    },
  });
  return { body, push: (c: string) => push(c), close: () => close() };
}

let rendered: FlowData[] = [];
function Harness({ process }: { process: AgenticProcess }) {
  rendered = useAgenticProcessStream(process);
  return null;
}

const userRows = (items: readonly FlowData[]) =>
  items.filter((i) => i.elementType === FlowElementTypes.USER_MESSAGE);

async function runTurnMidStream(wire: string) {
  const ap = new AgenticProcess({ id: PROC_ID, pty_mode: false, visible: false });
  dataManager.register_new_entity(PROC_TYPEID, ap);
  const stream = openBody();
  vi.spyOn(dataManager, 'callAction').mockImplementation(async (info: any) => {
    if (info?.name === 'prompt') return { body: stream.body } as unknown as Response;
    return undefined as unknown as Response;
  });
  render(<Harness process={ap} />);
  const turn = ap.prompt(PROMPT).catch(() => {});
  await act(async () => {
    stream.push(wire);
    await vi.waitFor(() => expect(ap.flowDataStream.items.some((i) => i.content === 'On it.')).toBe(true));
  });
  // The mocked body ignores the abort signal, so end the turn by closing it.
  return { ap, finish: async () => { stream.close(); await turn; } };
}

describe('Copilot live turn renders the user message once', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  it('retires the optimistic echo when the live stream carries the same user turn (copilot)', async () => {
    const { finish } = await runTurnMidStream(COPILOT_WIRE);
    try {
      const users = userRows(rendered);
      expect(users.map((u) => u.content)).toEqual([PROMPT]);
      // The survivor is the observation, not the placeholder.
      expect(users[0].isOptimisticEcho).toBe(false);
    } finally {
      await finish();
    }
  });

  it('keeps the echo when the live stream does not carry the user turn (claude)', async () => {
    const { finish } = await runTurnMidStream(CLAUDE_WIRE);
    try {
      const users = userRows(rendered);
      expect(users.map((u) => u.content)).toEqual([PROMPT]);
      expect(users[0].isOptimisticEcho).toBe(true);
    } finally {
      await finish();
    }
  });
});

function user(text: string, attrs: Record<string, string> = {}): FlowData {
  return FlowData.fromJSON({
    flow_value: text,
    attributes: { 'element-type': 'user-message', 'data-type': 'string', role: 'user', ...attrs },
  } as never);
}
const echo = (text: string) => user(text, { [FlowDataAttribute.OPTIMISTIC_ECHO]: 'true' });

describe('retireObservedEchoes pairing rule', () => {
  it('returns the same array when nothing is superseded', () => {
    const items = [echo('hi')];
    expect(retireObservedEchoes(items)).toBe(items);
  });

  it('an earlier observed "hi" never retires a later echo of "hi" (sent twice)', () => {
    const first = user('hi');
    const second = echo('hi');
    expect(retireObservedEchoes([first, second])).toEqual([first, second]);
  });

  it('pairs one observation to one echo, oldest first', () => {
    const e1 = echo('hi');
    const e2 = echo('hi');
    const o1 = user('hi');
    expect(retireObservedEchoes([e1, e2, o1])).toEqual([e2, o1]);
  });

  it('a framework-injected (meta) user row does not retire the echo', () => {
    const e = echo('hi');
    const meta = user('hi', { 'is-meta': 'true' });
    expect(retireObservedEchoes([e, meta])).toEqual([e, meta]);
  });

  it('follows arrival order, not render order (worker clock behind the browser clock)', () => {
    const e = echo('hi');
    const o = user('hi');
    // Rendered (timestamp-sorted) with the observed row first; it ARRIVED second.
    expect(retireObservedEchoes([o, e], [e, o])).toEqual([o]);
    // Arrived before the echo (an earlier turn): not this echo's observation.
    expect(retireObservedEchoes([e, o], [o, e])).toEqual([e, o]);
  });

  it('matches through surrounding whitespace', () => {
    const e = echo('hi');
    const o = user('hi\n');
    expect(retireObservedEchoes([e, o])).toEqual([o]);
  });
});
