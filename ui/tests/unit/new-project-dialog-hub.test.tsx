import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewProjectDialog } from '@src/components/project-selector/NewProjectDialog';

/**
 * The hub has no filesystem behind a project — a hub project is a pure entity.
 * With the folder row still rendered (and required) the hub's New-project
 * dialog could never enable Create: nothing on the hub can fill that field
 * (no native picker, no `desktop_info.paths.workspace`). `withFolder={false}`
 * drops the row and lets the name alone create.
 */
describe('NewProjectDialog folder row', () => {
  afterEach(cleanup);

  it('desk (default): requires the parent folder before Create enables', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<NewProjectDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    const create = screen.getByRole('button', { name: 'Create' });
    expect(screen.getByPlaceholderText('Project folder')).toBeTruthy();

    await userEvent.type(screen.getByPlaceholderText('Project name'), 'Alpha');
    expect((create as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByPlaceholderText('Project folder'), '/tmp/work');
    expect((create as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(create);
    expect(onCreate).toHaveBeenCalledWith('Alpha', '/tmp/work');
  });

  it('hub (withFolder=false): no folder row, and the name alone creates', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<NewProjectDialog open withFolder={false} onOpenChange={() => {}} onCreate={onCreate} />);

    expect(screen.queryByPlaceholderText('Project folder')).toBeNull();

    const create = screen.getByRole('button', { name: 'Create' });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByPlaceholderText('Project name'), 'Hub Alpha');
    expect((create as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(create);
    expect(onCreate).toHaveBeenCalledWith('Hub Alpha', '');
  });

  it('hub: a stale defaultParentFolder never leaks into the create call', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <NewProjectDialog
        open
        withFolder={false}
        defaultParentFolder="/leftover/workspace"
        onOpenChange={() => {}}
        onCreate={onCreate}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText('Project name'), 'Hub Beta');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith('Hub Beta', '');
  });
});
