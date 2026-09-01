/**
 * `LlmEndpointDialog`: root vs chain validation gates the submit, immutable
 * fields are disabled on edit, and the payload that reaches `dataManager.save`
 * is `buildEntityJson`'s — provider/base_url on create only, never the key —
 * with the key going through `setCredential` AFTER the entity exists.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  save: vi.fn(),
  setCredential: vi.fn(() => Promise.resolve({ ok: true, credential_hint: '****1234' })),
  onOpenChange: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save },
    llmEndpointsService: { ...(actual.llmEndpointsService as object), setCredential: h.setCredential },
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

describe('LlmEndpointDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.save.mockImplementation((typeId: { id: string }) => Promise.resolve({ id: typeId.id }));
  });
  afterEach(() => cleanup());

  it('root create: name required, then saves provider + base_url and sends the key separately', async () => {
    render(<LlmEndpointDialog open onOpenChange={h.onOpenChange} all={[]} />);

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
      sources: [],
    });
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
    render(<LlmEndpointDialog open onOpenChange={h.onOpenChange} all={[]} />);
    await userEvent.type(screen.getByTestId('llm-name'), 'Keyless');
    await userEvent.click(screen.getByTestId('llm-submit'));
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(h.setCredential).not.toHaveBeenCalled();
  });

  it('chain create: needs a source; the payload has sources in order and no provider', async () => {
    const rootA = saved({ id: uuid(), name: 'Root A', provider: 'openai' });
    const rootB = saved({ id: uuid(), name: 'Root B', provider: 'anthropic' });
    render(<LlmEndpointDialog open onOpenChange={h.onOpenChange} all={[rootA, rootB]} />);

    await userEvent.click(screen.getByTestId('kind-chain'));
    await userEvent.type(screen.getByTestId('llm-name'), 'Team chain');
    expect(screen.getByTestId('llm-problems').textContent).toContain('A chain needs at least one source.');
    expect(screen.queryByTestId('credential-field')).toBeNull();

    await userEvent.selectOptions(screen.getByTestId('source-select'), `llm_endpoint-${rootB.id}`);
    await userEvent.click(screen.getByTestId('source-add'));
    await userEvent.selectOptions(screen.getByTestId('source-select'), `llm_endpoint-${rootA.id}`);
    await userEvent.click(screen.getByTestId('source-add'));
    expect(screen.queryByTestId('llm-problems')).toBeNull();

    await userEvent.click(screen.getByTestId('llm-submit'));
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    const json = h.save.mock.calls[0][2] as unknown as Record<string, unknown>;
    expect(json.sources).toEqual([`llm_endpoint-${rootB.id}`, `llm_endpoint-${rootA.id}`]);
    expect(json).not.toHaveProperty('provider');
    expect(json).not.toHaveProperty('base_url');
    expect(h.setCredential).not.toHaveBeenCalled();
  });

  it('chain edit refuses a cycle and self-sourcing', async () => {
    const r = saved({ id: uuid(), name: 'R', provider: 'openai' });
    const b = saved({ id: uuid(), name: 'B', sources: [`llm_endpoint-${r.id}`] });
    const a = saved({ id: uuid(), name: 'A', sources: [`llm_endpoint-${b.id}`] });
    // A → B → R already; editing B to also source A closes the loop.
    render(<LlmEndpointDialog open onOpenChange={h.onOpenChange} editing={b} all={[r, b, a]} />);

    expect(screen.queryByTestId('llm-problems')).toBeNull();
    // B itself is never offered as a source.
    const options = Array.from(screen.getByTestId<HTMLSelectElement>('source-select').options).map((o) => o.value);
    expect(options).not.toContain(`llm_endpoint-${b.id}`);
    expect(options).toContain(`llm_endpoint-${a.id}`);

    await userEvent.selectOptions(screen.getByTestId('source-select'), `llm_endpoint-${a.id}`);
    await userEvent.click(screen.getByTestId('source-add'));
    expect(screen.getByTestId('llm-problems').textContent).toContain('These sources would form a cycle.');
    expect(screen.getByTestId('llm-submit')).toHaveProperty('disabled', true);
  });

  it('root edit: provider/base_url disabled, key field talks to the hub, save omits immutables', async () => {
    const root = saved({
      id: uuid(),
      name: 'Prod',
      provider: 'openai',
      base_url: 'https://api.openai.com',
      credential_hint: '****9999',
    });
    render(<LlmEndpointDialog open onOpenChange={h.onOpenChange} editing={root} all={[root]} />);

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
    render(<LlmEndpointDialog open onOpenChange={h.onOpenChange} editing={root} all={[root]} />);
    expect(screen.getByTestId('llm-submit')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('llm-name')).toHaveProperty('disabled', true);
  });
});
