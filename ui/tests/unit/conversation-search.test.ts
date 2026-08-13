import { describe, expect, it } from 'vitest';
import { FlowData, FlowElementTypes } from '@sdk';
import {
  contextWindowFor,
  findConversationHits,
  isInSession,
  searchableText,
  sessionIdOf,
  MAX_HITS,
} from '@src/hooks/use-conversation-search';

/** A prose row (assistant/user/tool-result/…) carrying `text`. */
function prose(elementType: string, text: string, attrs: Record<string, string> = {}): FlowData {
  return new FlowData(elementType as any, text, { 'data-type': 'string', ...attrs });
}

/** A structured TOOL_CALL row, shaped like `transcript_analyzer/entry.py` emits. */
function toolCall(toolName: string, input: Record<string, unknown>): FlowData {
  return new FlowData(
    FlowElementTypes.TOOL_CALL as any,
    JSON.stringify({ tool_name: toolName, tool_use_id: 'toolu_abc', tool_call_id: 'toolu_abc', input, args: input }),
    { 'data-type': 'object', 'tool-name': toolName },
  );
}

/** A replayed row, which carries the transcript envelope naming its session. */
function replayed(elementType: string, text: string, sessionId: string): FlowData {
  const item = prose(elementType, text);
  item.processEntry = { transcript_entry: { kind: 'assistant_message', session_id: sessionId } };
  return item;
}

describe('session scoping', () => {
  it('reads the session off a replayed row and reports null for a live one', () => {
    expect(sessionIdOf(replayed(FlowElementTypes.CHAT, 'x', 'sess-1'))).toBe('sess-1');
    expect(sessionIdOf(prose(FlowElementTypes.CHAT, 'x'))).toBeNull();
  });

  it('treats a row that names no session as live, hence current', () => {
    // Live rows arrive over the WS from the worker running right now.
    expect(isInSession(prose(FlowElementTypes.CHAT, 'x'), 'sess-1')).toBe(true);
  });

  it('excludes rows belonging to a previous session', () => {
    expect(isInSession(replayed(FlowElementTypes.CHAT, 'x', 'sess-0'), 'sess-1')).toBe(false);
    expect(isInSession(replayed(FlowElementTypes.CHAT, 'x', 'sess-1'), 'sess-1')).toBe(true);
  });

  it('filters nothing when no active session is known', () => {
    // An unknown scope must not silently empty the results.
    expect(isInSession(replayed(FlowElementTypes.CHAT, 'x', 'sess-0'), null)).toBe(true);
  });

  it('searches only the active session — a resumed process keeps the old rows', () => {
    const items = [
      replayed(FlowElementTypes.CHAT, 'ZEBRAMARKER from the previous run', 'sess-0'),
      replayed(FlowElementTypes.CHAT, 'ZEBRAMARKER from this run', 'sess-1'),
      prose(FlowElementTypes.CHAT, 'ZEBRAMARKER streaming in live'),
    ];
    const { hits } = findConversationHits(items, 'ZEBRAMARKER', { sessionId: 'sess-1' });
    expect(hits.map((h) => h.itemIndex)).toEqual([1, 2]);
  });

  it('searches every session when none is given', () => {
    const items = [
      replayed(FlowElementTypes.CHAT, 'ZEBRAMARKER old', 'sess-0'),
      replayed(FlowElementTypes.CHAT, 'ZEBRAMARKER new', 'sess-1'),
    ];
    expect(findConversationHits(items, 'ZEBRAMARKER').hits).toHaveLength(2);
  });

  it('does not pull context across a session boundary', () => {
    const items = [
      replayed(FlowElementTypes.CHAT, 'previous run tail', 'sess-0'),
      replayed(FlowElementTypes.CHAT, 'this run opener', 'sess-1'),
      replayed(FlowElementTypes.CHAT, 'ZEBRAMARKER', 'sess-1'),
      replayed(FlowElementTypes.CHAT, 'this run follow-up', 'sess-1'),
    ];
    const window = contextWindowFor(items, 2, { sessionId: 'sess-1' });
    expect(window.map((e) => e.itemIndex)).toEqual([1, 2, 3]);
  });
});

describe('findConversationHits — corpus filtering', () => {
  it('finds a match in an assistant message that scrolled out of the terminal', () => {
    const items = [prose(FlowElementTypes.CHAT, 'ZEBRAMARKER\n1. Blue whales are the largest animals.')];
    const { hits } = findConversationHits(items, 'zebramarker');
    expect(hits).toHaveLength(1);
    expect(hits[0].itemIndex).toBe(0);
    expect(hits[0].charOffset).toBe(0);
    expect(hits[0].label).toBe('agent');
    expect(hits[0].isUser).toBe(false);
  });

  it('labels user messages and matches them', () => {
    const items = [prose(FlowElementTypes.USER_MESSAGE, 'print ZEBRAMARKER then 200 lines', { role: 'user' })];
    const { hits } = findConversationHits(items, 'ZEBRAMARKER');
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe('user');
    expect(hits[0].isUser).toBe(true);
  });

  it('ignores element types outside the prose allowlist', () => {
    const items = [
      prose(FlowElementTypes.STATUS, 'ZEBRAMARKER in a status frame'),
      prose(FlowElementTypes.CHECKPOINT, 'ZEBRAMARKER in a checkpoint'),
      prose(FlowElementTypes.END, 'ZEBRAMARKER at the end'),
      prose(FlowElementTypes.PROGRESS_REPORT, 'ZEBRAMARKER progress'),
    ];
    expect(findConversationHits(items, 'ZEBRAMARKER').hits).toHaveLength(0);
  });

  it('excludes the empty {} placeholder rows that replay mints in bulk', () => {
    const item = prose(FlowElementTypes.CHAT, '{}');
    expect(searchableText(item)).toBe('');
    expect(findConversationHits([item], '{}').hits).toHaveLength(0);
  });

  it('excludes non-activity subtypes (token_usage, meta, summary)', () => {
    const items = [
      prose(FlowElementTypes.CHAT, 'ZEBRAMARKER tokens', { subtype: 'token_usage' }),
      prose(FlowElementTypes.CHAT, 'ZEBRAMARKER meta', { subtype: 'meta' }),
      prose(FlowElementTypes.CHAT, 'ZEBRAMARKER summary', { subtype: 'summary' }),
    ];
    expect(findConversationHits(items, 'ZEBRAMARKER').hits).toHaveLength(0);
  });
});

describe('findConversationHits — occurrences and ordering', () => {
  it('returns every occurrence in one message with ascending offsets', () => {
    const items = [prose(FlowElementTypes.CHAT, 'zebra ... zebra ... zebra')];
    const { hits } = findConversationHits(items, 'zebra');
    expect(hits.map((h) => h.charOffset)).toEqual([0, 10, 20]);
  });

  it('is case-insensitive but preserves the original casing in the snippet', () => {
    const items = [prose(FlowElementTypes.CHAT, 'The ZebraMarker line')];
    const { hits } = findConversationHits(items, 'zebramarker');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('ZebraMarker');
  });

  it('collapses newlines so a hit inside a 200-line answer stays one row', () => {
    const body = 'ZEBRAMARKER\n' + Array.from({ length: 200 }, (_, i) => `${i + 1}. animal fact`).join('\n');
    const { hits } = findConversationHits([prose(FlowElementTypes.CHAT, body)], 'ZEBRAMARKER');
    expect(hits[0].snippet).not.toContain('\n');
    expect(hits[0].snippet.slice(hits[0].snippetMatchStart)).toMatch(/^ZEBRAMARKER/);
  });

  it('returns hits in stream order across messages', () => {
    const items = [
      prose(FlowElementTypes.USER_MESSAGE, 'find zebra', { role: 'user' }),
      prose(FlowElementTypes.CHAT, 'zebra one'),
      prose(FlowElementTypes.TOOL_RESULT, 'zebra two'),
    ];
    const { hits } = findConversationHits(items, 'zebra');
    expect(hits.map((h) => h.itemIndex)).toEqual([0, 1, 2]);
  });

  it('returns nothing for an empty query', () => {
    expect(findConversationHits([prose(FlowElementTypes.CHAT, 'anything')], '').hits).toHaveLength(0);
  });
});

describe('findConversationHits — hit cap', () => {
  it('caps the list and reports truncation', () => {
    const items = [prose(FlowElementTypes.CHAT, 'zebra '.repeat(MAX_HITS + 50))];
    const { hits, truncated } = findConversationHits(items, 'zebra');
    expect(hits).toHaveLength(MAX_HITS);
    expect(truncated).toBe(true);
  });

  it('does not report truncation when everything fits', () => {
    const { hits, truncated } = findConversationHits([prose(FlowElementTypes.CHAT, 'zebra zebra')], 'zebra');
    expect(hits).toHaveLength(2);
    expect(truncated).toBe(false);
  });
});

describe('contextWindowFor — surroundings of an expanded hit', () => {
  const convo = () => [
    prose(FlowElementTypes.USER_MESSAGE, 'm0 question', { role: 'user' }),
    prose(FlowElementTypes.CHAT, 'm1 answer'),
    prose(FlowElementTypes.CHAT, 'm2 answer'),
    prose(FlowElementTypes.CHAT, 'm3 ZEBRAMARKER here'),
    prose(FlowElementTypes.CHAT, 'm4 answer'),
    prose(FlowElementTypes.CHAT, 'm5 answer'),
    prose(FlowElementTypes.CHAT, 'm6 answer'),
  ];

  it('returns two messages before and two after, with the match in the middle', () => {
    const window = contextWindowFor(convo(), 3);
    expect(window.map((e) => e.itemIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(window.filter((e) => e.isMatch).map((e) => e.itemIndex)).toEqual([3]);
  });

  it('skips noise rows when counting, so the window is readable messages', () => {
    // The real stream is mostly empty {} bookkeeping between messages; taking
    // items[i-2..i+2] verbatim would spend the window on rows that render as
    // nothing.
    const items = [
      prose(FlowElementTypes.CHAT, 'far before'),
      prose(FlowElementTypes.CHAT, 'near before'),
      prose(FlowElementTypes.CHAT, '{}'),
      prose(FlowElementTypes.STATUS, 'status noise'),
      prose(FlowElementTypes.CHAT, 'ZEBRAMARKER'),
      prose(FlowElementTypes.CHAT, '{}'),
      prose(FlowElementTypes.CHAT, 'near after'),
    ];
    const window = contextWindowFor(items, 4);
    expect(window.map((e) => e.itemIndex)).toEqual([0, 1, 4, 6]);
  });

  it('is one-sided at the start of the conversation', () => {
    const window = contextWindowFor(convo(), 0);
    expect(window.map((e) => e.itemIndex)).toEqual([0, 1, 2]);
    expect(window[0].isMatch).toBe(true);
  });

  it('is one-sided at the end of the conversation', () => {
    const window = contextWindowFor(convo(), 6);
    expect(window.map((e) => e.itemIndex)).toEqual([4, 5, 6]);
    expect(window[window.length - 1].isMatch).toBe(true);
  });

  it('carries the per-message isUser flag so each renders with its own role', () => {
    // Only one message precedes index 1, so the window is m0..m3 — the short
    // side is not padded by taking extra from the long one.
    const window = contextWindowFor(convo(), 1);
    expect(window.map((e) => e.itemIndex)).toEqual([0, 1, 2, 3]);
    expect(window.map((e) => e.isUser)).toEqual([true, false, false, false]);
  });

  it('always includes the match even when nothing around it is readable', () => {
    const items = [
      prose(FlowElementTypes.CHAT, '{}'),
      prose(FlowElementTypes.CHAT, 'ZEBRAMARKER'),
      prose(FlowElementTypes.STATUS, 'noise'),
    ];
    const window = contextWindowFor(items, 1);
    expect(window.map((e) => e.itemIndex)).toEqual([1]);
    expect(window[0].isMatch).toBe(true);
  });

  it('returns nothing for an out-of-range index', () => {
    expect(contextWindowFor(convo(), 99)).toEqual([]);
    expect(contextWindowFor([], 0)).toEqual([]);
  });
});

describe('findConversationHits — tool calls index arguments, not JSON keys', () => {
  it('matches the shell command inside a tool call', () => {
    const items = [toolCall('Bash', { command: 'grep -rn ZEBRAMARKER src/' })];
    const { hits } = findConversationHits(items, 'ZEBRAMARKER');
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe('Bash');
  });

  it('matches a file path inside a tool call', () => {
    const items = [toolCall('Read', { file_path: '/repo/ui/src/zebra.tsx' })];
    expect(findConversationHits(items, 'zebra.tsx').hits).toHaveLength(1);
  });

  it('does NOT match structural key names like tool_call_id', () => {
    const items = [toolCall('Bash', { command: 'ls -la' })];
    expect(findConversationHits(items, 'tool_call_id').hits).toHaveLength(0);
    expect(findConversationHits(items, 'toolu_abc').hits).toHaveLength(0);
  });
});
