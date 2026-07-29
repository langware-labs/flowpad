/**
 * Component test for `EnvLocalCard` — the detected-in-`.env.local` table.
 *
 * Three properties this surface must hold, all of them about what it does NOT
 * do:
 *  - it never renders a value (the action only returns names + line numbers);
 *  - "Declare" is additive and there is no delete affordance anywhere;
 *  - the row click only navigates, per the URL-first rule — no context writes.
 *
 * The Project is stood in for at its action boundary (`envLocalStatus` /
 * `addSecretPointer`); the component's own logic runs for real.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { EnvLocalCard } from '@src/components/project-home/EnvLocalCard';

const openMachinePath = vi.fn();

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openMachinePath }, currentDock: null }),
}));

vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn() },
}));

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    addSecretPointer: vi.fn().mockResolvedValue(undefined),
    envLocalStatus: vi.fn().mockResolvedValue({
      path: '/repo/.env.local',
      exists: true,
      gitignore: { in_repo: true, ignored: true, tracked: false, code: 'ignored', reason: 'ok' },
      blocked: false,
      block_code: null,
      block_reason: null,
      keys: [
        { key: 'OPENAI_API_KEY', line: 3, declared: false },
        { key: 'STRIPE_KEY', line: 7, declared: true },
      ],
      ...overrides,
    }),
  } as never;
}

describe('EnvLocalCard', () => {
  beforeEach(() => {
    openMachinePath.mockClear();
  });

  // The unit project has no global auto-cleanup; without this every render
  // stacks and getByTestId finds duplicates.
  afterEach(() => cleanup());

  it('lists detected keys with their line numbers', async () => {
    render(<EnvLocalCard project={makeProject()} />);

    expect(await screen.findByTestId('env-local-row-OPENAI_API_KEY')).toBeTruthy();
    expect(screen.getByTestId('env-local-row-STRIPE_KEY')).toBeTruthy();
    expect(screen.getByText('line 3')).toBeTruthy();
  });

  it('never renders a value', async () => {
    // The action cannot supply one; this pins that the card does not invent a
    // place to show one either.
    const { container } = render(<EnvLocalCard project={makeProject()} />);
    await screen.findByTestId('env-local-row-OPENAI_API_KEY');

    expect(container.textContent).not.toMatch(/sk-/);
    expect(container.querySelector('input')).toBeNull();
  });

  it('opens the file at the key line, and only navigates', async () => {
    render(<EnvLocalCard project={makeProject()} />);
    const trigger = await screen.findByTestId('env-local-open-OPENAI_API_KEY');

    await userEvent.click(trigger);

    expect(openMachinePath).toHaveBeenCalledTimes(1);
    expect(openMachinePath).toHaveBeenCalledWith('/repo/.env.local', expect.anything(), { line: 3 });
  });

  it('declares an undeclared key without touching .env.local', async () => {
    const project = makeProject();
    render(<EnvLocalCard project={project} />);

    await userEvent.click(await screen.findByTestId('env-local-declare-OPENAI_API_KEY'));

    await waitFor(() =>
      expect(project.addSecretPointer).toHaveBeenCalledWith('OPENAI_API_KEY', 'OPENAI_API_KEY', {
        locator: { kind: 'env-local', env_key: 'OPENAI_API_KEY' },
        scope: 'private',
        sodStore: 'env-local',
      }),
    );
  });

  it('offers no declare button for an already-declared key', async () => {
    render(<EnvLocalCard project={makeProject()} />);
    await screen.findByTestId('env-local-row-STRIPE_KEY');

    expect(screen.queryByTestId('env-local-declare-STRIPE_KEY')).toBeNull();
  });

  it('exposes no delete affordance at all', async () => {
    const { container } = render(<EnvLocalCard project={makeProject()} />);
    await screen.findByTestId('env-local-row-OPENAI_API_KEY');

    expect(container.textContent?.toLowerCase()).not.toContain('delete');
    expect(container.textContent?.toLowerCase()).not.toContain('remove');
  });

  it('shows the hard block and disables declaring when the file is committable', async () => {
    const project = makeProject({
      blocked: true,
      block_code: 'tracked',
      block_reason: '.env.local is already TRACKED by git.',
    });
    render(<EnvLocalCard project={project} />);

    expect((await screen.findByTestId('env-local-block')).textContent).toContain('TRACKED');
    expect((screen.getByTestId('env-local-declare-OPENAI_API_KEY')).disabled).toBe(true);
  });
});
