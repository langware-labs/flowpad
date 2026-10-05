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

const h = vi.hoisted(() => ({ models: vi.fn() }));
vi.mock('@src/components/llm-endpoints/use-llm-endpoints', () => ({
  useLlmEndpointModels: (id: string | undefined) => h.models(id),
}));
vi.mock('@src/components/llm-sources/use-llm-sources', () => ({
  useLlmSources: () => ({
    status: {
      available: [
        { id: SOURCE_ID, name: 'Team budget', kind: 'hub', can_administer: true },
        { id: 'b8473a10-74e5-4ce1-9fda-2babd551a399', name: 'Other budget', kind: 'hub', can_administer: true },
      ],
    },
    isLoading: false,
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TokenAllocationField } from '@src/components/assets/editor/agent-profile/TokenAllocationField';

const offered = (...ids: string[]) => ({ data: ids.map((id) => ({ id, root_id: 'llm_endpoint-root' })), isLoading: false });

beforeAll(() => {
  // cmdk scrolls its active row into view; jsdom does not implement it.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  h.models.mockReset();
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
    const names = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
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
    const names = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
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
