/**
 * AddDependencyDialog — the "+" on the Assets Dependencies root. Each source
 * tile hands its key to the host together with the chosen kind; Required is
 * the default, Optional a deliberate choice.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { AddDependencyDialog } from '@src/components/assets/AddDependencyDialog';
import { dependencySourceFor, hubProjectIdFrom } from '@src/components/assets/ProjectDependencyDialog';

function renderDialog(onPick = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <TooltipProvider>
      <AddDependencyDialog open onOpenChange={onOpenChange} onPick={onPick} />
    </TooltipProvider>,
  );
  return { onPick, onOpenChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddDependencyDialog', () => {
  it('offers one tile per source — a single Project tile, no separate hub one', () => {
    renderDialog();
    for (const id of ['project', 'browse', 'git']) {
      expect(screen.getByTestId(`add-dependency-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('add-dependency-hub')).not.toBeInTheDocument();
  });

  it('adds a local package by default, with Local the first choice', async () => {
    const user = userEvent.setup();
    const { onPick, onOpenChange } = renderDialog();
    const kinds = screen.getAllByRole('radio').map((r) => r.getAttribute('data-testid'));
    expect(kinds).toEqual(['add-dependency-kind-local', 'add-dependency-kind-required', 'add-dependency-kind-optional']);
    expect(screen.getByTestId('add-dependency-kind-local')).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByTestId('add-dependency-browse'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).toHaveBeenCalledWith('browse', 'local');
  });

  it('passes Required when chosen', async () => {
    const user = userEvent.setup();
    const { onPick } = renderDialog();

    await user.click(screen.getByTestId('add-dependency-kind-required'));
    await user.click(screen.getByTestId('add-dependency-browse'));

    expect(onPick).toHaveBeenCalledWith('browse', 'required');
  });

  it('passes Optional when chosen', async () => {
    const user = userEvent.setup();
    const { onPick } = renderDialog();

    await user.click(screen.getByTestId('add-dependency-kind-optional'));
    expect(screen.getByTestId('add-dependency-kind-optional')).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByTestId('add-dependency-project'));

    expect(onPick).toHaveBeenCalledWith('project', 'optional');
  });
});

describe('hubProjectIdFrom', () => {
  const ID = '0f3c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

  it('reads a bare id, a hub: source and a hub link', () => {
    expect(hubProjectIdFrom(ID)).toBe(ID);
    expect(hubProjectIdFrom(` hub:${ID} `)).toBe(ID);
    expect(hubProjectIdFrom(`https://hub.example.com/dock/project/${ID.toUpperCase()}/hub`)).toBe(ID);
  });

  it('refuses anything that names no project', () => {
    expect(hubProjectIdFrom('')).toBeNull();
    expect(hubProjectIdFrom('my-project')).toBeNull();
  });
});

describe('dependencySourceFor', () => {
  const ID = '0f3c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

  it('saves a published project by its hub id, so it resolves on any machine', () => {
    expect(dependencySourceFor({ id: ID, hub_published_at: '2026-10-01T00:00:00Z', fs_storage_mount_path: '/w/a' })).toBe(`hub:${ID}`);
  });

  it('saves an unpublished project by its folder', () => {
    expect(dependencySourceFor({ id: ID, hub_published_at: null, fs_storage_mount_path: '/w/a' })).toBe('/w/a');
  });
});
