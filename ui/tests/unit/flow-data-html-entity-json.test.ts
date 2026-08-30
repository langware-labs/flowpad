import { AgenticProcess, FlowData, FlowElementTypes, dataManager } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FLOWPAD-2038 — an HTML entity in the transcript wipes the whole chat on /get-history.
 *
 * An agent that writes `&quot;` through the Write tool leaves the entity verbatim in
 * the transcript. The tool-call row is an OBJECT row, so on replay `FlowData.fromJSON`
 * serializes it back to JSON and `parseElementData` runs `decodeXMLEntities` over the
 * WHOLE serialized document before `JSON.parse` (flow-data.ts, "Decode XML entities
 * first"). The decode rewrites `&quot;` to a bare `"`, closing the JSON string early:
 *
 *   {"tool_name":"Write",…,"content":"print(&quot;hi&quot;)"}
 *                     ↓ decodeXMLEntities
 *   {"tool_name":"Write",…,"content":"print("hi")"}
 *   SyntaxError: Expected ',' or '}' after property value in JSON at position 104
 *
 * It does not stop at that one row. `_setError` emits ERROR on a FlowData with no
 * error listener, so the emitter itself throws `Unhandled error. (…)`; the rethrow
 * escapes the constructor, aborts `loadHistory`'s ingestion loop, and is swallowed by
 * its outer "history loading failure shouldn't break the app" catch — leaving the
 * stream EMPTY. That is the reported symptom: the chat history disappears.
 *
 * Entered through `loadHistory()` — the real `get-history` action — because the
 * corruption is specific to the history/JSONL ingestion path. Live frames arrive
 * pre-split through the XML stream parser and never hand a whole JSON document to
 * the entity decoder.
 */

const PROCESS_ID = '00000000-0000-4000-8000-00000000e038';

/** The Write tool call the agent made — its file content contains an HTML entity. */
const WRITE_TOOL_CALL = {
  tool_name: 'Write',
  tool_call_id: 'call-2038',
  args: {
    file_path: '/tmp/hello.html',
    content: 'print(&quot;hello&quot;)',
  },
};

function toolCallRow(payload: unknown) {
  return {
    flow_value: payload,
    created_time: '2026-08-26T18:00:00.100Z',
    attributes: {
      'element-type': FlowElementTypes.TOOL_CALL,
      'data-type': 'object',
      'transcript-entry-id': 'tool-2038',
      subtype: 'tool_use',
      'tool-use-id': 'call-2038',
    },
  };
}

function chatRow(id: string, text: string, timestamp: string) {
  return {
    flow_value: text,
    created_time: timestamp,
    attributes: {
      'element-type': FlowElementTypes.CHAT,
      'data-type': 'string',
      'transcript-entry-id': id,
      role: 'assistant',
      subtype: 'assistant_message',
    },
  };
}

/** A three-row conversation: chat, the entity-bearing tool call, chat. */
function historyWithEntityToolCall() {
  return [
    chatRow('chat-1', 'Writing the file now.', '2026-08-26T18:00:00.000Z'),
    toolCallRow(WRITE_TOOL_CALL),
    chatRow('chat-2', 'Done — the file is written.', '2026-08-26T18:00:00.200Z'),
  ];
}

describe('FLOWPAD-2038: HTML entities in transcript rows survive get-history replay', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    callActionSpy = vi.spyOn(dataManager, 'callAction');
  });

  afterEach(() => {
    callActionSpy.mockRestore();
  });

  function serveHistory(history: unknown[]) {
    callActionSpy.mockResolvedValue({
      history,
      count: history.length,
      session_id: 'session-2038',
      use_worker_history: true,
    } as never);
  }

  it('does not drop the conversation when one row contains &quot;', async () => {
    // THE REPORTED SYMPTOM. One malformed row must not empty the pane — today the
    // parse error escapes FlowData's constructor, aborts the ingestion loop and is
    // swallowed by loadHistory, so getOutputs() returns [] and the chat vanishes.
    const history = historyWithEntityToolCall();
    serveHistory(history);

    const process = new AgenticProcess({ id: PROCESS_ID });
    await process.loadHistory({ force: true });

    expect(process.getOutputs()).toHaveLength(history.length);
  });

  it('parses the entity-bearing tool call instead of raising Invalid JSON format', async () => {
    serveHistory(historyWithEntityToolCall());

    const process = new AgenticProcess({ id: PROCESS_ID });
    await process.loadHistory({ force: true });

    const tool = process.getOutputs().find((item) => item.elementType === FlowElementTypes.TOOL_CALL);
    expect(tool, 'the tool-call row never reached the stream').toBeDefined();
    // Today: "…Invalid JSON format: SyntaxError: Expected ',' or '}' after property
    // value in JSON at position 104" — the exact error reported on the ticket.
    expect(tool!.error_msg).toBe('');
    expect(tool!.error).toBe(false);
    // The transcript recorded the six characters `&quot;`, not a quote mark, so the
    // payload must round-trip verbatim.
    expect(tool!.data).toEqual(WRITE_TOOL_CALL);
  });

  it('keeps the surrounding chat rows readable', async () => {
    serveHistory(historyWithEntityToolCall());

    const process = new AgenticProcess({ id: PROCESS_ID });
    await process.loadHistory({ force: true });

    const outputs = process.getOutputs();
    expect(outputs.filter((item) => item.error)).toHaveLength(0);
    expect(outputs.map((item) => item.content)).toEqual([
      'Writing the file now.',
      JSON.stringify(WRITE_TOOL_CALL),
      'Done — the file is written.',
    ]);
  });

  it('still decodes a genuine XML-stream escape on a string row', async () => {
    // Guard rail for the fix: string rows off the XML stream legitimately carry
    // `&lt;`/`&gt;`/`&amp;` escaping and that decode must keep working. Only the
    // OBJECT/ENTITY path — where the decode is applied to a whole JSON document
    // before parsing it — is wrong.
    const row = FlowData.fromJSON({
      flow_value: 'use &lt;div&gt; &amp; friends',
      created_time: '2026-08-26T18:00:00.300Z',
      attributes: {
        'element-type': FlowElementTypes.CHAT,
        'data-type': 'string',
        role: 'assistant',
      },
    });

    expect(row.content).toBe('use <div> & friends');
  });
});
