/**
 * `NodeSecrets` — which of a project's secrets a compute node may see.
 *
 * The surface is value-free: rows are env var names and there is nothing here
 * that could render a value. What is worth pinning beyond that is the
 * uncurated case — a node nobody has narrowed sees everything, and the panel
 * has to say so rather than implying someone picked those rows.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { NodeSecrets } from '@src/components/machine-overview/node-secrets';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'node-1',
    attachSecret: vi.fn().mockResolvedValue(undefined),
    detachSecret: vi.fn().mockResolvedValue(undefined),
    attachAllSecrets: vi.fn().mockResolvedValue(undefined),
    listAttachedSecrets: vi.fn().mockResolvedValue({
      project_id: 'proj-1',
      all_attached: false,
      secrets: [
        { env_var: 'A_KEY', attached: true },
        { env_var: 'B_KEY', attached: false },
      ],
      ...overrides,
    }),
  } as never;
}

const project = { id: 'proj-1' } as never;

describe('NodeSecrets', () => {
  afterEach(() => cleanup());

  it('lists the project’s declared secrets with their attach state', async () => {
    render(<NodeSecrets computeNode={makeNode()} project={project} />);

    expect(await screen.findByTestId('node-secret-row-A_KEY')).toBeTruthy();
    expect((screen.getByTestId('node-secret-toggle-A_KEY') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('node-secret-toggle-B_KEY') as HTMLInputElement).checked).toBe(false);
  });

  it('renders no value, and offers nowhere to type one', async () => {
    const { container } = render(<NodeSecrets computeNode={makeNode()} project={project} />);
    await screen.findByTestId('node-secret-row-A_KEY');

    expect(container.textContent).not.toMatch(/sk-/);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it('attaches on check and detaches on uncheck', async () => {
    const node = makeNode();
    render(<NodeSecrets computeNode={node} project={project} />);

    await userEvent.click(await screen.findByTestId('node-secret-toggle-B_KEY'));
    await waitFor(() => expect(node.attachSecret).toHaveBeenCalledWith('proj-1', 'B_KEY'));

    await userEvent.click(screen.getByTestId('node-secret-toggle-A_KEY'));
    await waitFor(() => expect(node.detachSecret).toHaveBeenCalledWith('proj-1', 'A_KEY'));
  });

  it('attach-all is one call, not one per secret', async () => {
    const node = makeNode();
    render(<NodeSecrets computeNode={node} project={project} />);
    await screen.findByTestId('node-secret-row-A_KEY');

    await userEvent.click(screen.getByTestId('node-secrets-attach-all'));

    await waitFor(() => expect(node.attachAllSecrets).toHaveBeenCalledTimes(1));
    expect(node.attachSecret).not.toHaveBeenCalled();
  });

  it('says so when nothing has been narrowed yet', async () => {
    const node = makeNode({ all_attached: true });
    render(<NodeSecrets computeNode={node} project={project} />);

    expect(await screen.findByTestId('node-secrets-all-note')).toBeTruthy();
  });

  it('asks for a project rather than showing an empty list', async () => {
    render(<NodeSecrets computeNode={makeNode()} project={null} />);

    expect(await screen.findByTestId('node-secrets-no-project')).toBeTruthy();
  });
});
