/**
 * `<flowpad-agent>` — a served page's agent, from the SDK alone: it finds the agent the app is
 * nested in, its icon toggles a chat that slides in from the left (the page narrows), and the chat
 * is the agent's last one, live, with New chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataManager } from '@sdk/APIEntity';
import { Agent } from '@sdk/entities/agent';
import { chatRows, defineAgentElement } from '@sdk/apps/agent-panel';

const ENDPOINT = '9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const WEBAPP = 'b9312997-b348-57f9-8f6b-1a970e33e9a9';
const AGENT = 'ab32dd2f-d5c1-4493-9713-66bac77da6cf';

type Row = { elementType: string; content: string; attributes: Record<string, string>; processEntry?: unknown };
const msg = (elementType: string, content: string): Row => ({ elementType, content, attributes: {} });
const tool = (name: string, path: string): Row => ({
  elementType: 'tool-call',
  content: '',
  attributes: { 'tool-name': name },
  processEntry: { transcript_entry: { path } },
});

/** A process the panel can read: a stream it listens to, and the calls it makes. */
function fakeProcess(id: string, items: Row[] = []) {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    id,
    busy: false,
    status: 'running',
    flowDataStream: {
      items,
      on: vi.fn((event: string, fn: () => void) => (listeners[event] ??= []).push(fn)),
      off: vi.fn((event: string, fn: () => void) => (listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn))),
    },
    emit: (event: string) => (listeners[event] ?? []).forEach((fn) => fn()),
    listening: () => Object.values(listeners).flat().length,
    subscribe: vi.fn(() => () => {}),
    watch: vi.fn(async () => async () => {}),
    loadHistory: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const shadow = (el: Element) => el.shadowRoot!;
const panel = () => document.querySelector('[data-testid="flowpad-agent-panel"]') as HTMLElement;

/** Mount the tag; `ready` waits until it found its agent (it draws its toggle). */
async function mount({ ready = true } = {}): Promise<HTMLElement> {
  const el = document.createElement('flowpad-agent');
  document.body.appendChild(el);
  if (ready) await vi.waitFor(() => expect(el.shadowRoot?.querySelector('button')).not.toBeNull());
  else for (let i = 0; i < 5; i++) await flush();
  return el;
}

beforeEach(() => {
  defineAgentElement();
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
  window.history.replaceState(null, '', `/api/v1/graph/service_endpoint/${ENDPOINT}/service/`);
  // The unit tier has no backend: the SDK's bootstrap answers at once instead of waiting on DNS.
  vi.spyOn(dataManager, 'bootstrap').mockRejectedValue(new Error('no backend in the unit tier'));
  const scrooge = new Agent({ id: AGENT, name: 'scrooge', title: 'Scrooge' } as never);
  vi.spyOn(dataManager, 'getByTypeId').mockImplementation(async (typeId: { toString(): string }) => {
    const rows: Record<string, unknown> = {
      [`service_endpoint-${ENDPOINT}`]: { id: ENDPOINT, type: 'service_endpoint', webapp_id: WEBAPP },
      [`micro_app-${WEBAPP}`]: { id: WEBAPP, type: 'micro_app', parent_type_id: `agent-${AGENT}`, project_id: 'p-1', typeId: { toString: () => `micro_app-${WEBAPP}` } },
      [`agent-${AGENT}`]: scrooge,
    };
    return (rows[typeId.toString()] ?? null) as never;
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-fp-agent');
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('chatRows', () => {
  it('draws messages as they are and folds a run of tool calls into one muted row', () => {
    const rows = chatRows([
      msg('user-message', 'how many deals?'),
      msg('user-message', 'how many deals?'), // the echo and the transcript copy: one message
      tool('Read', 'deals.json'),
      tool('Bash', 'count.py'),
      msg('chat', '12 open deals.'),
    ] as never);
    expect(rows).toEqual([
      { kind: 'me', text: 'how many deals?' },
      { kind: 'tool', label: 'Bash', detail: 'count.py', count: 2 },
      { kind: 'agent', text: '12 open deals.' },
    ]);
  });
});

describe('<flowpad-agent>', () => {
  it('finds the agent the app is nested in and starts nothing until opened', async () => {
    const open = vi.spyOn(Agent.prototype, 'openChat');
    const el = await mount();
    expect(el.hidden).toBe(false);
    expect(shadow(el).querySelector('button')?.getAttribute('aria-label')).toBe('Scrooge');
    expect(open).not.toHaveBeenCalled();
  });

  it('hides on a page that is not a served app', async () => {
    window.history.replaceState(null, '', '/index.html');
    const el = await mount({ ready: false });
    expect(el.hidden).toBe(true);
  });

  it('the icon toggles the chat, and the page makes room for it', async () => {
    const chat = fakeProcess('p-last', [msg('user-message', 'hi'), msg('chat', 'Hello!')]);
    const open = vi.spyOn(Agent.prototype, 'openChat').mockResolvedValue(chat as never);
    const el = await mount();
    const toggle = shadow(el).querySelector('button')!;

    toggle.click();
    await flush();
    expect(open).toHaveBeenCalledWith('p-1');
    expect(document.documentElement.getAttribute('data-fp-agent')).toBe('open');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel().hasAttribute('open')).toBe(true);
    const rows = [...shadow(panel()).querySelectorAll('[data-row]')].map((r) => r.textContent);
    expect(rows).toEqual(['hi', 'Hello!']);

    toggle.click();
    expect(document.documentElement.hasAttribute('data-fp-agent')).toBe(false);
    expect(panel().hasAttribute('open')).toBe(false);
  });

  it('shows what streams in, and Enter sends', async () => {
    const chat = fakeProcess('p-last');
    vi.spyOn(Agent.prototype, 'openChat').mockResolvedValue(chat as never);
    const el = await mount();
    shadow(el).querySelector('button')!.click();
    await flush();

    chat.flowDataStream.items.push(msg('chat', 'streamed reply') as never);
    chat.emit('data');
    expect(shadow(panel()).querySelector('[data-row="agent"]')?.textContent).toBe('streamed reply');

    const input = shadow(panel()).querySelector('textarea')!;
    input.value = 'next question';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(chat.enqueue).toHaveBeenCalledWith('next question', 'page');
  });

  it('New chat swaps the chat and stops listening to the old one', async () => {
    const last = fakeProcess('p-last', [msg('chat', 'old')]);
    const fresh = fakeProcess('p-new');
    vi.spyOn(Agent.prototype, 'openChat').mockResolvedValue(last as never);
    const create = vi.spyOn(Agent.prototype, 'newChat').mockResolvedValue(fresh as never);
    const el = await mount();
    shadow(el).querySelector('button')!.click();
    await flush();
    expect(last.listening()).toBe(2);

    (shadow(panel()).querySelector('[data-act="new"]') as HTMLButtonElement).click();
    await flush();
    expect(create).toHaveBeenCalledWith('p-1');
    expect(last.listening()).toBe(0);
    expect(fresh.listening()).toBe(2);
    expect(shadow(panel()).querySelector('[data-row]')).toBeNull();
  });

  it('a failed open says why and offers Try again', async () => {
    vi.spyOn(Agent.prototype, 'openChat').mockRejectedValueOnce(new Error('no worker'));
    const el = await mount();
    shadow(el).querySelector('button')!.click();
    await vi.waitFor(() => expect(shadow(panel()).querySelector('[role="alert"]')?.textContent).toBe('no worker'));
    expect(shadow(panel()).querySelector('[data-act="retry"]')).not.toBeNull();
  });
});
