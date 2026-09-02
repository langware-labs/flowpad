/**
 * `LlmEndpointDialog`: root vs chain validation gates the submit, immutable fields are disabled on
 * edit, and the payload that reaches `dataManager.save` is `buildEntityJson`'s — provider/base_url
 * on create only, never the key — with the key going through `setCredential` AFTER the entity
 * exists.
 *
 * The two kinds take DIFFERENT calls on create, and that is the sharpest thing here. A root is an
 * entity create. A chain is `allocate` POSTed to the endpoint it draws from, because the hub
 * authorizes delegation against the budget being delegated. Creating a chain as an entity carrying
 * `sources` silently made a keyless ROOT — the hub drops unrecognised fields and still answers 200 —
 * so `save` must NOT be what a chain create reaches.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  save: vi.fn(),
  setCredential: vi.fn(() => Promise.resolve({ ok: true, credential_hint: '****1234' })),
  allocate: vi.fn(),
  onOpenChange: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save },
    llmEndpointsService: {
      ...(actual.llmEndpointsService as object),
      setCredential: h.setCredential,
      allocate: h.allocate,
    },
  };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

import { LLMEndpoint } from '@sdk';

import { LlmEndpointDialog } from '@src/components/llm-endpoints/LlmEndpointDialog';

let seq = 100;
const uuid = () => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000`;

function saved(json: Record<string, unknown>, allowed = ['read', 'update', 'delete']): LLMEndpoint {
  const e = new LLMEndpoint({ ...json, created_date: new Date() } as never);
  e.expand = { expansions: ['permissions'], allowed_actions: allowed };
  return e;
}

/** The dialog resolves an edit target's real kind from its chain report (`entity.kind` answers
 *  `root` for every endpoint), so it needs query context. Rendering it bare threw
 *  "No QueryClient set". */
function renderDialog(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('LlmEndpointDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.save.mockImplementation((typeId: { id: string }) => Promise.resolve({ id: typeId.id }));
  });
  afterEach(() => cleanup());

  it('root create: name required, then saves provider + base_url and sends the key separately', async () => {
    renderDialog(<LlmEndpointDialog open onOpenChange={h.onOpenChange} all={[]} />);

    const submit = screen.getByTestId('llm-submit');
    expect(submit).toHaveProperty('disabled', true);
    expect(screen.getByTestId('llm-problems').textContent).toContain('Name is required.');

    await userEvent.type(screen.getByTestId('llm-name'), 'Anthropic prod');
    await userEvent.click(screen.getByTestId('provider-anthropic'));
    expect(screen.getByTestId<HTMLInputElement>('llm-base-url').value).toBe('https://api.anthropic.com');
    await userEvent.type(screen.getByTestId('credential-input'), 'sk-ant-secret');
    expect(submit).toHaveProperty('disabled', false);

    await userEvent.click(submit);

    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    const [typeId, scope, json] = h.save.mock.calls[0] as unknown as [
      { type: string },
      unknown[],
      Record<string, unknown>,
    ];
    expect(typeId.type).toBe('llm_endpoint');
    expect(scope).toEqual([]);
    expect(json).toMatchObject({
      name: 'Anthropic prod',
      enabled: true,
      provider: 'anthropic',
      base_url: 'https://api.anthropic.com',
    });
    expect(json).not.toHaveProperty('sources');
    expect(JSON.stringify(json)).not.toContain('sk-ant-secret');

    // The key travels through the credential action, to the id the save returned.
    await waitFor(() => expect(h.setCredential).toHaveBeenCalledOnce());
    const [id, key] = h.setCredential.mock.calls[0] as unknown as [string, string];
    expect(key).toBe('sk-ant-secret');
    expect(id).toBe((h.save.mock.calls[0][0] as { id: string }).id);
    // The save happened BEFORE the credential call.
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.setCredential.mock.invocationCallOrder[0]);
    expect(h.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a root without a key saves without touching the credential action', async () => {
    renderDialog(<LlmEndpointDialog open onOpenChange={h.onOpenChange} all={[]} />);
    await userEvent.type(screen.getByTestId('llm-name'), 'Keyless');
    await userEvent.click(screen.getByTestId('llm-submit'));
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(h.setCredential).not.toHaveBeenCalled();
  });

  it('chain create: needs a parent, then allocates on it instead of creating an entity', async () => {
    const rootA = saved({ id: uuid(), name: 'Root A', provider: 'openai' });
    const rootB = saved({ id: uuid(), name: 'Root B', provider: 'anthropic' });
    h.allocate.mockResolvedValueOnce(saved({ id: uuid(), name: 'Team chain' }));
    renderDialog(<LlmEndpointDialog open onOpenChange={h.onOpenChange} all={[rootA, rootB]} />);

    await userEvent.click(screen.getByTestId('kind-chain'));
    await userEvent.type(screen.getByTestId('llm-name'), 'Team chain');
    expect(screen.getByTestId('llm-problems').textContent).toContain('Choose the endpoint this one draws from.');
    expect(screen.queryByTestId('credential-field')).toBeNull();

    await userEvent.selectOptions(screen.getByTestId('source-select'), `llm_endpoint-${rootB.id}`);
    expect(screen.queryByTestId('llm-problems')).toBeNull();

    await userEvent.click(screen.getByTestId('llm-submit'));
    await waitFor(() => expect(h.allocate).toHaveBeenCalledOnce());

    // The parent is the URL — a bare uuid, not a typeid — and the body is the CHILD's budget.
    const [parentId, body] = h.allocate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(parentId).toBe(rootB.id);
    expect(body.name).toBe('Team chain');
    expect(body).not.toHaveProperty('sources');
    expect(body).not.toHaveProperty('provider');

    // The entity-create door is the one that silently produced a keyless root.
    expect(h.save).not.toHaveBeenCalled();
    expect(h.setCredential).not.toHaveBeenCalled();
  });

  it('chain edit: the parent is fixed at allocation, so it is not offered', async () => {
    const r = saved({ id: uuid(), name: 'R', provider: 'openai' });
    const b = saved({ id: uuid(), name: 'B', sources: [`llm_endpoint-${r.id}`] });
    renderDialog(<LlmEndpointDialog open onOpenChange={h.onOpenChange} editing={b} all={[r, b]} />);

    // Re-sourcing is not a thing any more: the link is an edge only `allocate` writes.
    expect(screen.queryByTestId('source-picker')).toBeNull();
    expect(screen.queryByTestId('llm-problems')).toBeNull();
    expect(screen.getByTestId('llm-submit')).toHaveProperty('disabled', false);
  });

  it('root edit: provider/base_url disabled, key field talks to the hub, save omits immutables', async () => {
    const root = saved({
      id: uuid(),
      name: 'Prod',
      provider: 'openai',
      base_url: 'https://api.openai.com',
      credential_hint: '****9999',
    });
    renderDialog(<LlmEndpointDialog open onOpenChange={h.onOpenChange} editing={root} all={[root]} />);

    expect(screen.getByTestId('provider-openai')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('llm-base-url')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('credential-hint').textContent).toContain('****9999');
    // Save/Test appear because the endpoint exists.
    expect(screen.getByTestId('credential-save')).toBeTruthy();

    await userEvent.clear(screen.getByTestId('llm-name'));
    await userEvent.type(screen.getByTestId('llm-name'), 'Prod v2');
    await userEvent.click(screen.getByTestId('llm-submit'));

    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    const [typeId, , json] = h.save.mock.calls[0] as unknown as [{ id: string }, unknown, Record<string, unknown>];
    expect(typeId.id).toBe(root.id);
    expect(json.name).toBe('Prod v2');
    expect(json).not.toHaveProperty('provider');
    expect(json).not.toHaveProperty('base_url');
    expect(json).not.toHaveProperty('credential_hint');
    expect(h.setCredential).not.toHaveBeenCalled();
  });

  it('a reader cannot submit an edit', () => {
    const root = saved({ id: uuid(), name: 'RO', provider: 'openai' }, ['read']);
    renderDialog(<LlmEndpointDialog open onOpenChange={h.onOpenChange} editing={root} all={[root]} />);
    expect(screen.getByTestId('llm-submit')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('llm-name')).toHaveProperty('disabled', true);
  });

  it('editing a chain opens a CHAIN form, even though the entity claims to be a root', async () => {
    // The bug this pins: `entity.kind` reads `sources`, which the hub does not serialize, so every
    // endpoint reports `root`. Editing a chain therefore opened the ROOT form — provider buttons, a
    // base URL and a key field, none of which a chain has. The caller passes the chain-resolved
    // kind, and the form must believe it over the entity.
    const chain = saved({ id: uuid(), name: 'test7' });
    expect(chain.kind).toBe('root');

    renderDialog(
      <LlmEndpointDialog open onOpenChange={h.onOpenChange} editing={chain} editingKind="chain" all={[chain]} />,
    );

    expect(screen.queryByTestId('llm-base-url')).toBeNull();
    expect(screen.queryByTestId('provider-openai')).toBeNull();
    expect(screen.getByTestId('llm-name')).toBeTruthy();
  });
});
