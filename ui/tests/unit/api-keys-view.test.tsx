/**
 * `ApiKeysView` — user-scoped, and now frameless.
 *
 * Pins the delete-by-id fix: the table's button used to pass the key NAME to a
 * handler that keys on id, so it silently did nothing while the panel above it
 * worked.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ remove: vi.fn(), keys: [] as unknown[] }));

vi.mock('@src/components/api-keys-view/use-user-api-keys', () => ({
  useUserApiKeys: () => ({
    apiKeys: h.keys,
    flowpadKey: undefined,
    generatedKey: null,
    generate: vi.fn(),
    remove: h.remove,
    reload: vi.fn(),
  }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { ApiKeysView } from '@src/components/api-keys-view/api-keys-view';

const KEY = {
  id: 'key-id-1',
  name: 'FLOWPAD_API_KEY',
  description: 'CLI',
  visible_value: '****abcd',
  target_typeid: 'user-1',
  is_active: true,
};

describe('ApiKeysView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.keys = [KEY];
  });
  afterEach(() => cleanup());

  it('deletes by id, not by name', async () => {
    render(<ApiKeysView />);

    await userEvent.click(screen.getByTestId('api-key-delete-key-id-1'));

    expect(h.remove).toHaveBeenCalledWith('key-id-1');
    expect(h.remove).not.toHaveBeenCalledWith('FLOWPAD_API_KEY');
  });

  it('owns no frame or width cap of its own', () => {
    render(<ApiKeysView />);
    const root = screen.getByTestId('api-keys-view');

    expect(root.className).not.toContain('max-w-4xl');
    expect(root.className).not.toContain('h-full');
  });

  it('takes the width cap from its host', () => {
    render(<ApiKeysView className="max-w-4xl" />);

    expect(screen.getByTestId('api-keys-view').className).toContain('max-w-4xl');
  });

  it('hides its heading when the host supplies one', () => {
    const { rerender } = render(<ApiKeysView />);
    expect(screen.queryByText('API Keys')).toBeTruthy();

    rerender(<ApiKeysView header={false} />);
    expect(screen.queryByText('API Keys')).toBeNull();
  });

  it('will not offer to delete a revoked key', () => {
    h.keys = [{ ...KEY, is_active: false }];
    render(<ApiKeysView />);

    expect((screen.getByTestId('api-key-delete-key-id-1')).disabled).toBe(true);
  });
});
