/**
 * `Task.assign()` — the one-call assignment facade.
 *
 * Everything the caller needs is a person and (optionally) a note: the entity
 * method owns the action call, the local `assignee` stamp, and the optional
 * notification. These assert the wire contract of the first half — action name,
 * target, and body — plus the shapes that must NOT reach the network
 * (self-assign, `notify: false`).
 *
 * Spies on the shared `dataManager` singleton rather than vi.mock()ing the
 * module: the SDK entity imports it relatively, so a specifier-based mock
 * wouldn't intercept it (same reason as journey-entity-methods.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataManager, Task } from '@sdk';

// The notification send is its own module (a hub round-trip); what the task does with its
// answer is what is under test here.
const send = vi.hoisted(() => ({ createAndSendConversation: vi.fn() }));
vi.mock('@sdk/entities/conversation-send', () => send);

// Fresh id per task: the SDK entity registry warns when the same id is
// re-registered with a different instance across tests.
let TASK_ID = '';

let callAction: ReturnType<typeof vi.spyOn>;

const assignResult = (over: Record<string, unknown> = {}) => ({
  self: false,
  assignee: 'bob@x.com',
  ...over,
});

const task = () => new Task({ id: TASK_ID, type: 'task', title: 'Fix login' });

beforeEach(() => {
  TASK_ID = crypto.randomUUID();
  callAction = vi.spyOn(dataManager, 'callAction').mockResolvedValue(assignResult() as never);
});
afterEach(() => vi.restoreAllMocks());

describe('Task.assign', () => {
  it('POSTs assign-task at this task with the recipient and note', async () => {
    const out = await task().assign(
      { email: 'Bob@X.com', name: 'Bob' },
      { message: '  please take a look  ', notify: false },
    );

    expect(callAction).toHaveBeenCalledTimes(1);
    const info = callAction.mock.calls[0][0] as any;
    expect(info.name).toBe('assign-task');
    expect(info.targetEntity.toString()).toBe(`task-${TASK_ID}`);
    expect(info.method).toBe('POST');
    // Email normalized, message trimmed — the backend receives clean input.
    expect(info.bodyParameters).toEqual({
      email: 'bob@x.com',
      name: 'Bob',
      message: 'please take a look',
    });
    expect(out).toEqual({ conversationId: null, self: false });
  });

  it('accepts a bare email string', async () => {
    await task().assign('carol@x.com', { notify: false });
    expect((callAction.mock.calls[0][0] as any).bodyParameters).toEqual({ email: 'carol@x.com' });
  });

  it('stamps assignee locally so the caller’s copy reflects the change', async () => {
    const t = task();
    expect(t.assignee).toBeUndefined();
    await t.assign('bob@x.com', { notify: false });
    expect(t.assignee).toBe('bob@x.com');
  });

  it('sends nothing else when assigning to yourself', async () => {
    callAction.mockResolvedValue(
      assignResult({ child: null, self: true, created: false, assignee: 'me@x.com' }) as never,
    );

    const out = await task().assign('me@x.com');

    // No notification conversation: a self-assignment has nobody to notify.
    expect(callAction).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ conversationId: null, self: true });
  });

  it('keeps the conversation it was asked in, so opening the task opens that conversation', async () => {
    // The setup file loaded the SDK before this file's mock registered: a fresh graph sees it.
    vi.resetModules();
    const sdk = await import('@sdk');
    send.createAndSendConversation.mockResolvedValue({ conversation_id: 'conv-1' });
    const call = vi.spyOn(sdk.dataManager, 'callAction').mockResolvedValue(assignResult() as never);
    const t = new sdk.Task({ id: crypto.randomUUID(), type: 'task', title: 'Fix login' });

    const out = await t.assign('bob@x.com', { message: 'please look' });

    expect(out).toEqual({ conversationId: 'conv-1', self: false });
    expect(t.origin_conversation).toBe('conv-1');
    // A local action, never a field save: a save of a shared task round-trips through the hub,
    // which does not model the link and would drop it.
    const link = call.mock.calls[1][0] as any;
    expect(link.name).toBe('link-conversation');
    expect(link.bodyParameters).toEqual({ conversation_id: 'conv-1' });
  });

  it('requires a recipient email', async () => {
    await expect(task().assign({ name: 'No Email' })).rejects.toThrow(/recipient email/i);
    expect(callAction).not.toHaveBeenCalled();
  });
});
