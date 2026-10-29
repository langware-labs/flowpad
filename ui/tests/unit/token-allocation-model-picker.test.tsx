/**
 * Token allocation's model: picked from the models the chosen source offers. The hub lists them
 * by the endpoint's bare id, so the field asks with that — never the `llm_endpoint-<uuid>` typeid
 * the source select holds — and shows them as a searchable list.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agent, type AgentTokenAllocation } from '@sdk';

const SOURCE_ID = 'a8473a10-74e5-4ce1-9fda-2babd551a399';
const SOURCE = `llm_endpoint-${SOURCE_ID}`;

const h = vi.hoisted(() => ({ models: vi.fn(), chain: vi.fn(() => ({ data: undefined })) }));
/** A hub row as the listing serves it: the caller's permitted actions ride its expansion. */
const row = (id: string, name: string, actions: string[]) => ({ id, name, canAllocate: actions.includes('allocate') });
vi.mock('@src/components/llm-endpoints/use-llm-endpoints', () => ({
  useLlmEndpointModels: (id: string | undefined) => h.models(id),
  useLlmEndpointChain: (id: string | undefined) => h.chain(id),
  useLlmEndpoints: () => ({
    endpoints: [
      row(SOURCE_ID, 'Team budget', ['read', 'update', 'allocate']),
      row('b8473a10-74e5-4ce1-9fda-2babd551a399', 'Other budget', ['read', 'update', 'allocate']),
      // Held, not administered: its holder may still carve a sub-budget from it.
      row('c8473a10-74e5-4ce1-9fda-2babd551a399', 'My allowance', ['read', 'invoke', 'allocate']),
      row('d8473a10-74e5-4ce1-9fda-2babd551a399', 'Spend only', ['read', 'invoke']),
    ],
    isLoading: false,
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TokenAllocationField } from '@src/components/assets/editor/agent-profile/TokenAllocationField';

const offered = (...ids: string[]) => ({
  data: ids.map((id) => ({ id, root_id: 'llm_endpoint-root' })),
  isLoading: false,
});

beforeAll(() => {
  // cmdk scrolls its active row into view; jsdom does not implement it.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  h.models.mockReset();
  h.chain.mockReset();
  h.chain.mockReturnValue({ data: undefined });
});

const agent = new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', enabled: true });

function renderField(value: AgentTokenAllocation) {
  const onChange = vi.fn();
  render(<TokenAllocationField agent={agent} environment="production" value={value} onChange={onChange} />);
  return onChange;
}

const allocation = (model = ''): AgentTokenAllocation => ({ source: SOURCE, cost_usd_per_day: 5, model });

describe('Token allocation model', () => {
  it('asks for the source models by its bare id, not its typeid', () => {
    h.models.mockReturnValue(offered('anthropic/claude-haiku-4.5', 'openai/gpt-5'));
    renderField(allocation());
    expect(h.models).toHaveBeenLastCalledWith(SOURCE_ID);
  });

  it('lists the models the source offers and sets the one picked', async () => {
    h.models.mockReturnValue(offered('openai/gpt-5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'));
    const onChange = renderField(allocation());

    const picker = screen.getByTestId('token-allocation-model');
    expect(picker).toHaveAttribute('role', 'combobox');
    await userEvent.click(picker);
    const names = within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5', 'openai/gpt-5']);

    await userEvent.click(screen.getByTestId('token-allocation-model-anthropic/claude-sonnet-5'));
    expect(onChange).toHaveBeenLastCalledWith({ ...allocation(), model: 'anthropic/claude-sonnet-5' });
  });

  it('filters the list by what is typed', async () => {
    h.models.mockReturnValue(offered('openai/gpt-5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'));
    renderField(allocation());

    await userEvent.click(screen.getByTestId('token-allocation-model'));
    await userEvent.type(await screen.findByPlaceholderText('Filter models…'), 'SONNET');
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['anthropic/claude-sonnet-5']),
    );
  });

  it('takes the only model a source offers without asking', async () => {
    h.models.mockReturnValue(offered('anthropic/claude-haiku-4.5'));
    const onChange = renderField(allocation());
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ ...allocation(), model: 'anthropic/claude-haiku-4.5' }),
    );
  });

  it('keeps the agent model selectable when the source does not list it under that name', async () => {
    h.models.mockReturnValue(offered('anthropic/claude-haiku-4.5', 'openai/gpt-5'));
    renderField(allocation('haiku'));

    const picker = screen.getByTestId('token-allocation-model');
    expect(picker).toHaveTextContent('haiku');
    await userEvent.click(picker);
    const names = within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(['haiku', 'anthropic/claude-haiku-4.5', 'openai/gpt-5']);
  });

  it('is typed while the source models are unknown', () => {
    h.models.mockReturnValue({ data: undefined, isLoading: true });
    renderField(allocation());
    const field = screen.getByTestId('token-allocation-model');
    expect(field.tagName).toBe('INPUT');
    expect(field).toHaveAttribute('placeholder', 'Loading models…');
  });
});

describe('token allocation by size', () => {
  it('offers the sizes the source declares first, each with the model it resolves to', async () => {
    h.models.mockReturnValue(offered('google/gemini-3.1-flash-lite', 'google/gemini-3.1-pro-preview'));
    h.chain.mockReturnValue({
      data: {
        effective_tiers: {
          sm: { model: 'google/gemini-3.1-flash-lite', set_by: 'x', reason: '' },
          md: { model: null, set_by: null, reason: 'none' },
          lg: { model: 'google/gemini-3.1-pro-preview', set_by: 'x', reason: '' },
        },
      },
    });
    const onChange = renderField(allocation());
    await userEvent.click(screen.getByTestId('token-allocation-model'));
    expect(screen.getByTestId('token-allocation-size-lg')).toHaveTextContent('lg' + 'google/gemini-3.1-pro-preview');
    expect(screen.queryByTestId('token-allocation-size-md')).toBeNull();
    await userEvent.click(screen.getByTestId('token-allocation-size-lg'));
    expect(onChange).toHaveBeenLastCalledWith(allocation('lg'));
  });

  it('a chosen size reads as the size and its model', () => {
    h.models.mockReturnValue(offered('google/gemini-3.1-pro-preview', 'google/gemini-3.1-flash-lite'));
    h.chain.mockReturnValue({
      data: { effective_tiers: { lg: { model: 'google/gemini-3.1-pro-preview', set_by: 'x', reason: '' } } },
    });
    renderField(allocation('lg'));
    expect(screen.getByTestId('token-allocation-model')).toHaveTextContent('lg · google/gemini-3.1-pro-preview');
  });

  it('a budget the person holds is a source; one they may only spend is not', async () => {
    h.models.mockReturnValue(offered());
    renderField(allocation());
    const select = screen.getByTestId('token-allocation-source');
    const names = within(select)
      .queryAllByRole('option')
      .map((o) => o.textContent);
    expect(names.join('|')).toContain('My allowance');
    expect(names.join('|')).not.toContain('Spend only');
  });
});
