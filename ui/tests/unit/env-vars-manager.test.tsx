/**
 * `EnvVarsManager` — the entity-scoped env-var table, now frameless.
 *
 * The load-bearing assertion here is the API key panel: keys belong to the
 * USER, this table belongs to an ENTITY, and the two were fused. It is opt-in
 * now, so a new mount cannot inherit the confusion by accident.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  remove: vi.fn(),
  table: { values: [] as unknown[] },
  error: null as unknown,
  user: { id: 'u1', typeId: { type: 'user', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } } as unknown,
}));

vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: h.user }),
  useEntityEnv: () => ({ table: h.table, isLoading: false, error: h.error }),
  useEntityEnvMutations: () => ({
    create: vi.fn(),
    update: vi.fn(),
    remove: h.remove,
    invalidate: vi.fn(),
  }),
}));
vi.mock('@src/components/api-keys-view/use-user-api-keys', () => ({
  useUserApiKeys: () => ({
    apiKeys: [],
    flowpadKey: undefined,
    generatedKey: null,
    generate: vi.fn(),
    remove: vi.fn(),
    reload: vi.fn(),
  }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { EnvVarsManager } from '@src/components/EnvVarsManager';

const PROJECT = {
  type: 'project',
  id: '8a1b6d5c-2e34-4f7a-9b1c-77c0de6f9a12',
  toString: () => 'project-8a1b6d5c-2e34-4f7a-9b1c-77c0de6f9a12',
} as never;

const ROW = { name: 'OPENAI_API_KEY', var_type: 'api_key', visible_value: '****abcd', var_status: 'AVAILABLE' };

describe('EnvVarsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.table = { values: [ROW] };
    h.error = null;
  });
  afterEach(() => cleanup());

  it('does not render the API key panel unless asked', () => {
    render(<EnvVarsManager entityTypeId={PROJECT} />);

    expect(screen.queryByTestId('flowpad-api-key-panel')).toBeNull();
  });

  it('renders it when a host opts in', () => {
    render(<EnvVarsManager entityTypeId={PROJECT} apiKeyPanel />);

    expect(screen.getByTestId('flowpad-api-key-panel')).toBeTruthy();
  });

  it('owns no frame, and takes a className', () => {
    render(<EnvVarsManager entityTypeId={PROJECT} className="h-full p-4" />);
    const root = screen.getByTestId('env-vars-manager');

    expect(root.className).toContain('h-full');
    expect(root.className).toContain('min-h-0');
  });

  it('hides its heading when the host supplies one', () => {
    const { rerender } = render(<EnvVarsManager entityTypeId={PROJECT} />);
    expect(screen.queryByText('Environment Variables')).toBeTruthy();

    rerender(<EnvVarsManager entityTypeId={PROJECT} header={false} />);
    expect(screen.queryByText('Environment Variables')).toBeNull();
    // The Add button survives — it is the surface's only way to create one.
    expect(screen.getByTestId('env-var-add')).toBeTruthy();
  });

  it('surfaces a load error instead of showing an empty table', () => {
    h.error = { response: { data: { detail: 'backend is unhappy' } } };
    render(<EnvVarsManager entityTypeId={PROJECT} />);

    expect(screen.getByTestId('env-vars-error').textContent).toContain('backend is unhappy');
  });

  it('shows the masked value and never a raw secret', () => {
    render(<EnvVarsManager entityTypeId={PROJECT} />);

    expect(screen.getByText('****abcd')).toBeTruthy();
    expect(screen.getByTestId('env-vars-manager').textContent).not.toMatch(/sk-/);
  });

  it('deletes a row through the shared mutation', async () => {
    render(<EnvVarsManager entityTypeId={PROJECT} />);

    const buttons = screen.getAllByRole('button');
    await userEvent.click(buttons[buttons.length - 1]);

    expect(h.remove).toHaveBeenCalledWith('OPENAI_API_KEY');
  });
});
