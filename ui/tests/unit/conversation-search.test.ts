import { describe, expect, it } from 'vitest';
import { FlowData, FlowElementTypes } from '@sdk';
import { findConversationHits, searchableText, MAX_HITS } from '@src/hooks/use-conversation-search';

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
