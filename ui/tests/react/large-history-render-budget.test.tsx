/**
 * QA issue D10 — large-history chat performance budget.
 *
 * Drives the production pipeline end-to-end in jsdom: a real FlowDataStream →
 * `useAgenticProcessStream` (useSyncExternalStore snapshotting) →
 * `useTurnGroups` (incremental, identity-stable grouping) → `TurnGroupsList`
 * (memoized rows). Asserts correctness (cardinality + first/last identity for
 * a 1,010-frame corpus) AND wall-clock bounds on the compute we control.
 * jsdom render time is not browser paint time, but the dominant costs this
 * pins (per-frame regrouping, full-list re-renders, per-access stream sorts)
 * are the same code in both.
 *
 * Measured on the dev machine (Node 22 / jsdom, vitest single worker):
 *
 *                                   pre-fix        fixed
 *   initial 1,010-frame render      ~400 ms        ~400 ms   (unchanged — all rows must mount once)
 *   100 live-appended frames        ~10,430 ms     ~150 ms   (was: full regroup + full-list re-render per frame)
 *   force reload (clear+append)     ~400 ms        ~400 ms   (one full rebuild, not two)
 *
 * Bounds below are ~4-10× the fixed numbers — honest headroom for CI noise,
 * NOT inflation — and the pre-fix code exceeds the live-append bound by ~7×
 * (measured 10,432 ms by reverting the three touched src files to HEAD with a
 * naive useMemo(groupTurnEvents) shim and re-running this file).
 */
import { AgenticProcess, FlowData, FlowDataStream, FlowElementTypes, PrefKey, instancePreferences } from '@sdk';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';
import { useTurnGroups } from '@src/components/floating-chat/groupTurnEvents';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';

const CORPUS_SIZE = 1010;
const FIRST_PROMPT = 'user prompt 1 — D10 corpus start';
const FINAL_REPLY = 'assistant reply — D10 corpus end';

function fd(
  elementType: string,
  flowValue: unknown,
  attributes: Record<string, string>,
  index: number,
): FlowData {
  const item = FlowData.fromJSON({
    flow_value: flowValue,
    index,
    created_time: new Date(1760000000000 + index * 500).toISOString(),
    attributes: { 'element-type': elementType, ...attributes },
  });
  item.markReady();
  item.source = 'History';
  return item;
}

/**
 * Deterministic ~1,010-frame corpus shaped like the QA D10 scenario: repeated
 * turns of user message → assistant text → 4 tool_call/result pairs (object
 * payloads) → a trailing hook STATUS. Ends on a recognizable assistant reply.
 */
function buildCorpus(): { corpus: FlowData[]; messageCount: number; denseGroupCount: number } {
  const corpus: FlowData[] = [];
  let turn = 0;
  let messageCount = 0;
  let denseGroupCount = 0;
  // Each full turn is 11 frames: 2 messages + 8 tool frames + 1 status.
  while (corpus.length + 11 <= CORPUS_SIZE - 1) {
    turn++;
    corpus.push(fd(FlowElementTypes.USER_MESSAGE, `user prompt ${turn} — D10 corpus start`, { role: 'user', 'data-type': 'string' }, corpus.length));
    messageCount++;
    corpus.push(fd(FlowElementTypes.CHAT, `assistant reply ${turn}: working through a moderately long paragraph of streamed agent output text.`, { role: 'assistant', 'data-type': 'string' }, corpus.length));
    messageCount++;
    for (let k = 0; k < 4; k++) {
      const id = `call-${turn}-${k}`;
      corpus.push(fd(FlowElementTypes.TOOL_CALL, { tool_name: 'exec_command', tool_use_id: id, tool_call_id: id, args: { cmd: `ls -la /tmp/dir${k}` } }, { 'data-type': 'object', 'tool-name': 'exec_command', 'tool-use-id': id, subtype: 'tool_use' }, corpus.length));
      corpus.push(fd(FlowElementTypes.TOOL_RESULT, JSON.stringify({ tool_call_id: id, content: 'x'.repeat(400) }), { 'data-type': 'object', 'tool-use-id': id }, corpus.length));
    }
    corpus.push(fd(FlowElementTypes.STATUS, JSON.stringify({ detail: 'y'.repeat(200) }), { subtype: 'PostToolUse', 'data-type': 'string' }, corpus.length));
    denseGroupCount++;
  }
  // Pad to exactly CORPUS_SIZE-1 with plain assistant messages, then close
  // on the recognizable final reply.
  while (corpus.length < CORPUS_SIZE - 1) {
    corpus.push(fd(FlowElementTypes.CHAT, `padding message ${corpus.length}`, { role: 'assistant', 'data-type': 'string' }, corpus.length));
    messageCount++;
  }
  corpus.push(fd(FlowElementTypes.CHAT, FINAL_REPLY, { role: 'assistant', 'data-type': 'string' }, corpus.length));
  messageCount++;
  return { corpus, messageCount, denseGroupCount };
}

/** A follow-on live turn: tool events streamed one frame at a time. */
function buildLiveFrames(count: number): FlowData[] {
  const frames: FlowData[] = [];
  for (let k = 0; k < count; k++) {
    const id = `live-${k}`;
    frames.push(
      fd(FlowElementTypes.TOOL_CALL, { tool_name: 'exec_command', tool_use_id: id, tool_call_id: id, args: { cmd: `echo live ${k}` } }, { 'data-type': 'object', 'tool-name': 'exec_command', 'tool-use-id': id, subtype: 'tool_use' }, CORPUS_SIZE + k),
    );
  }
  return frames;
}

/** Production pipeline harness: stream → snapshot hook → grouper → list. */
function ChatHarness({ stream }: { stream: FlowDataStream }) {
  const items = useAgenticProcessStream({ flowDataStream: stream } as unknown as AgenticProcess);
  const groups = useTurnGroups(items);
  return <TurnGroupsList groups={groups} worker="claude" />;
}

describe('D10 large-history render budget', () => {
  beforeEach(() => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, true);
  });
  afterEach(() => {
    cleanup();
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });

  it('renders a 1,010-frame history correctly within budget, and live appends stay O(delta)', () => {
    const { corpus, messageCount, denseGroupCount } = buildCorpus();
    expect(corpus.length).toBe(CORPUS_SIZE);

    const stream = new FlowDataStream('d10-budget');
    stream.append(corpus); // history load: single coalesced batch (one 'data' emit)

    // ── Initial render ──────────────────────────────────────────────────────
    let t0 = performance.now();
    const { container } = render(<ChatHarness stream={stream} />);
    const initialMs = performance.now() - t0;

    // Cardinality: every message and every dense run is on screen.
    const messages = container.querySelectorAll('div.contents[data-role]');
    const denseRows = container.querySelectorAll('[data-testid="dense-tool-row"]');
    expect(messages.length).toBe(messageCount);
    expect(denseRows.length).toBe(denseGroupCount);

    // First/last identity.
    expect(messages[0].textContent).toContain(FIRST_PROMPT);
    expect(messages[messages.length - 1].textContent).toContain(FINAL_REPLY);

    // Measured fixed ≈400ms (pre-fix identical — every row mounts once either
    // way). Bound is correctness-of-scale, not a pre/post discriminator.
    expect(initialMs).toBeLessThan(2500);

    // ── Live-turn churn: 100 frames appended one 'data' emit at a time ─────
    // Each act() flushes the useSyncExternalStore notification like a WS
    // frame arriving in its own task. Pre-fix this re-grouped the whole
    // 1,000+ item array AND re-rendered every row per frame: measured
    // ~10,430ms. Fixed (incremental grouper + identity-stable committed
    // groups + memoized rows + cached stream sort): measured ~150ms.
    const liveFrames = buildLiveFrames(100);
    t0 = performance.now();
    for (const frame of liveFrames) {
      act(() => stream.append(frame));
    }
    const liveMs = performance.now() - t0;
    expect(liveMs).toBeLessThan(1500);

    // The appended live turn is on screen (one growing trailing dense group).
    expect(container.querySelectorAll('[data-testid="dense-tool-row"]').length).toBe(denseGroupCount + 1);

    // ── Force reload (A7 useTurnCompletionReconcile: clear + append) ────────
    // Must cost ONE full rebuild, not two: the clear's empty render is trivial
    // and the re-append regroups/renders once. Measured ≈400ms fixed.
    t0 = performance.now();
    act(() => {
      stream.clear();
      stream.append([...corpus, ...liveFrames]);
    });
    const reloadMs = performance.now() - t0;
    expect(reloadMs).toBeLessThan(2500);

    // Identical content after the authoritative replace.
    const reloadedMessages = container.querySelectorAll('div.contents[data-role]');
    expect(reloadedMessages.length).toBe(messageCount);
    expect(reloadedMessages[0].textContent).toContain(FIRST_PROMPT);
    expect(container.querySelectorAll('[data-testid="dense-tool-row"]').length).toBe(denseGroupCount + 1);
  });

  it('incremental grouping matches the pure grouper on append-only growth', async () => {
    // Differential correctness: the identity-stable incremental path must
    // produce the same partition the pure function computes from scratch.
    const { groupTurnEvents, createTurnGrouper } = await import('@src/components/floating-chat/groupTurnEvents');
    const { corpus } = buildCorpus();
    const grouper = createTurnGrouper();
    const sizes = [0, 1, 7, 8, 100, 101, 500, corpus.length];
    for (const n of sizes) {
      const slice = corpus.slice(0, n);
      const incremental = grouper.next(slice);
      const pure = groupTurnEvents(slice);
      expect(incremental.length).toBe(pure.length);
      for (let i = 0; i < pure.length; i++) {
        expect(incremental[i].kind).toBe(pure[i].kind);
        expect(incremental[i].index).toBe(pure[i].index);
        if (pure[i].kind === 'message') {
          expect((incremental[i] as any).flowData).toBe((pure[i] as any).flowData);
        } else {
          expect((incremental[i] as any).events).toEqual((pure[i] as any).events);
        }
      }
    }
    // Non-append change (truncation) falls back to a full rebuild.
    const truncated = corpus.slice(0, 20);
    expect(grouper.next(truncated)).toEqual(groupTurnEvents(truncated));
  });

  it('keeps committed group identity stable across appends', () => {
    const { corpus } = buildCorpus();
    const stream = new FlowDataStream('d10-identity');
    stream.append(corpus);

    let captured: unknown[] = [];
    function Probe({ stream: s }: { stream: FlowDataStream }) {
      const items = useAgenticProcessStream({ flowDataStream: s } as unknown as AgenticProcess);
      const groups = useTurnGroups(items);
      captured = groups;
      return null;
    }
    render(<Probe stream={stream} />);
    const before = [...captured];

    act(() => stream.append(buildLiveFrames(1)));
    const after = captured as unknown[];

    // Every group that existed before the append keeps its object identity —
    // this is what lets React.memo skip all committed rows per live frame.
    expect(after.length).toBe(before.length + 1);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBe(before[i]);
    }
  });
});
