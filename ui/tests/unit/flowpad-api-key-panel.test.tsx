/**
 * `FlowPadApiKeyPanel` — one implementation of what used to be two, one of them
 * embedded inside an entity-scoped env-var table.
 *
 * Purely presentational: it renders whatever `useUserApiKeys` hands it and calls
 * back. The tests drive it with a plain object rather than the real hook.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { FlowPadApiKeyPanel, GeneratedApiKeyCallout } from '@src/components/api-keys-view/FlowPadApiKeyPanel';
import type { UseUserApiKeys } from '@src/components/api-keys-view/use-user-api-keys';

const ACTIVE = {
  id: 'k1',
  name: 'FLOWPAD_API_KEY',
  description: 'for the CLI',
  visible_value: '****abcd',
  target_typeid: 'user-1',
  is_active: true,
};

function keys(overrides: Partial<UseUserApiKeys> = {}): UseUserApiKeys {
  return {
    apiKeys: [],
    flowpadKey: undefined,
    generatedKey: null,
    generate: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    ...overrides,
  };
}

describe('FlowPadApiKeyPanel', () => {
  afterEach(() => cleanup());

  it('offers to generate when there is no active key', async () => {
    const generate = vi.fn().mockResolvedValue(undefined);
    render(<FlowPadApiKeyPanel keys={keys({ generate })} />);

    await userEvent.click(screen.getByTestId('flowpad-api-key-generate'));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('flowpad-api-key-delete')).toBeNull();
  });

  it('shows the existing key and hands the whole row to remove', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    render(<FlowPadApiKeyPanel keys={keys({ flowpadKey: ACTIVE, remove })} />);

    expect(screen.getByText('FLOWPAD_API_KEY')).toBeTruthy();
    expect(screen.getByText('****abcd')).toBeTruthy();

    await userEvent.click(screen.getByTestId('flowpad-api-key-delete'));

    // `remove` takes the row, not an identifier: the hub revokes by NAME, and
    // a bare id failed silently. Passing the row makes that a type error.
    expect(remove).toHaveBeenCalledWith(ACTIVE);
    expect(remove).not.toHaveBeenCalledWith('k1');
  });

  it('never renders the full secret — only the masked value', () => {
    const { container } = render(<FlowPadApiKeyPanel keys={keys({ flowpadKey: ACTIVE })} />);

    expect(container.textContent).toContain('****abcd');
    expect(container.textContent).not.toMatch(/sk-/);
  });
});

describe('GeneratedApiKeyCallout', () => {
  afterEach(() => cleanup());

  it('shows the secret once, with the warning that it will not be shown again', () => {
    render(<GeneratedApiKeyCallout apiKey={{ api_key: 'sk-generated-once' } as never} />);

    const textarea = screen.getByTestId('generated-api-key').querySelector('textarea');
    expect((textarea as HTMLTextAreaElement).value).toBe('sk-generated-once');
    expect((textarea as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByTestId('generated-api-key').textContent).toMatch(/won.t be able to see it again/i);
  });
});
