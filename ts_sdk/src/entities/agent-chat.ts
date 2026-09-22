import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { Deployment } from './deployment';
import { ServiceEndpoint } from './service-endpoint';

/** What a chat turn produced, as it is produced. */
export type AgentChatEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'error'; message: string }
  | { type: 'done'; conversationId: string };

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A deployed agent's `chat` endpoint, spoken the OpenAI way (`v1/chat/completions`).
 *
 * The endpoint belongs to one placement — this computer or a cloud box — and the
 * turn runs there; for a box, this backend forwards to the hub and the hub to the
 * box. Whoever may use the endpoint may chat. A conversation is the caller's own:
 * pass back the `conversationId` a turn answered with to continue it.
 */
export class AgentChat {
  constructor(readonly endpoint: ServiceEndpoint) {}

  /** The `chat` endpoint of *deployment* — for a cloud placement, as the hub has it now. */
  static async forDeployment(deployment: Deployment): Promise<AgentChat | null> {
    const endpoint = (await deployment.endpoints()).find((e) => e.name === 'chat' && e.backend.type === 'agent');
    return endpoint ? new AgentChat(endpoint) : null;
  }

  /** Send *text*; yields the conversation it is in (when it is new), then what the agent writes as it writes it, ending with `done` (or `error`). */
  async *send(
    text: string,
    opts: { conversationId?: string | null; signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentChatEvent> {
    const action = new ActionInfo('service', ServiceEndpoint.type, this.endpoint.id, 'POST', false, true, opts.signal ?? null);
    action.subpath = 'v1/chat/completions';
    action.bodyParameters = {
      model: `agent-${this.endpoint.backend.type === 'agent' ? this.endpoint.backend.agent_id : ''}`,
      stream: true,
      messages: [{ role: 'user', content: text }],
      ...(opts.conversationId ? { metadata: { conversation_id: opts.conversationId } } : {}),
    };
    const response = await dataManager.callAction<unknown, Response>(action);
    if (!response?.body) throw new Error('the chat endpoint answered without a stream');
    // The body names the conversation on every chunk — a header would need CORS exposure cross-origin.
    let conversationId = opts.conversationId ?? '';
    for await (const payload of sseData(response.body)) {
      if (payload === '[DONE]') break;
      const chunk = parseJson(payload);
      if (!chunk) continue;
      const named = chunk.flowpad?.conversation_id ? String(chunk.flowpad.conversation_id) : '';
      if (named && named !== conversationId) {
        // Named on the turn's first chunk: a caller keeps it from then on, not only once the turn is over.
        conversationId = named;
        yield { type: 'conversation', conversationId };
      }
      if (chunk.error) {
        yield { type: 'error', message: String(chunk.error.message ?? 'the turn failed') };
        continue;
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
      if (chunk.flowpad?.tool) yield { type: 'tool', name: String(chunk.flowpad.tool) };
    }
    yield { type: 'done', conversationId };
  }

  /** The conversation so far, oldest first. */
  async history(conversationId: string): Promise<AgentChatMessage[]> {
    const action = new ActionInfo('service', ServiceEndpoint.type, this.endpoint.id, 'GET', true);
    action.subpath = `v1/conversations/${encodeURIComponent(conversationId)}`;
    // A raw response — the service speaks its own shape, not the envelope — is the body text.
    const raw = await dataManager.callAction<unknown, unknown>(action);
    const body = typeof raw === 'string' ? parseJson(raw) : raw;
    return Array.isArray(body?.messages) ? (body.messages as AgentChatMessage[]) : [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The `data:` payloads of a Server-Sent Events body, one per event. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
      end = buffer.indexOf('\n\n');
    }
  }
}
