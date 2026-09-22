import { AgentChat, dataManager, sseData, ServiceEndpoint } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENDPOINT = new ServiceEndpoint({
  id: '2c3d7e0a-5a1b-4f7e-9d2c-8b6a1e4f0c11',
  name: 'chat',
  parent_type_id: 'deployment-7a1f9b3c-2d4e-4a6b-8c0d-1e2f3a4b5c6d',
  protocol: { spec_kind: 'api.chat.openai' },
  backend: { type: 'agent', agent_id: 'a-1' },
} as never);

function sse(...events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Split mid-event: a real stream arrives in arbitrary pieces.
      controller.enqueue(bytes.slice(0, 7));
      controller.enqueue(bytes.slice(7));
      controller.close();
    },
  });
}

function chunk(delta: object, flowpad: object = {}) {
  return { choices: [{ index: 0, delta }], flowpad: { conversation_id: 'c-1', ...flowpad } };
}

afterEach(() => vi.restoreAllMocks());

describe('AgentChat', () => {
  it('reads an agent backend', () => {
    expect(ENDPOINT.backend).toEqual({ type: 'agent', agent_id: 'a-1' });
  });

  it('parses Server-Sent Events across arbitrary chunk boundaries', async () => {
    const seen: string[] = [];
    for await (const data of sseData(sse({ a: 1 }, '[DONE]'))) seen.push(data);
    expect(seen).toEqual(['{"a":1}', '[DONE]']);
  });

  it('streams the turn as text and tool events, then done with the conversation', async () => {
    const body = sse(chunk({ role: 'assistant' }), chunk({}, { tool: 'Read' }), chunk({ content: 'hello' }), chunk({}), '[DONE]');
    const spy = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue(new Response(body, { headers: { 'x-flowpad-conversation': 'c-1' } }) as never);

    const events = [];
    for await (const event of new AgentChat(ENDPOINT).send('hi', { conversationId: 'c-0' })) events.push(event);

    expect(events).toEqual([
      { type: 'tool', name: 'Read' },
      { type: 'text', text: 'hello' },
      { type: 'done', conversationId: 'c-1' },
    ]);
    const action = spy.mock.calls[0][0] as { subpath: string; bodyParameters: Record<string, unknown> };
    expect(action.subpath).toBe('v1/chat/completions');
    expect(action.bodyParameters).toMatchObject({
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { conversation_id: 'c-0' },
    });
  });

  it('surfaces a refused turn as an error event', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(
      new Response(sse({ error: { message: 'busy' } }, '[DONE]')) as never,
    );
    const events = [];
    for await (const event of new AgentChat(ENDPOINT).send('hi')) events.push(event);
    expect(events[0]).toEqual({ type: 'error', message: 'busy' });
  });
});
