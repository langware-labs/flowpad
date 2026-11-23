/**
 * Where a new source is saved is the person's choice: "Me" (their own, in no project) or "Project"
 * (the one open). A message channel starts on Me, a data source on Project; an agent's source is
 * not asked, and with no project open only Me can be picked.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent, DataDriver, DataSource, Project, TypeId, User } from '@sdk';

const hoisted = vi.hoisted(() => ({ specs: [] as unknown[], project: null as unknown, hub: false }));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => hoisted.hub }));
vi.mock('@src/components/data-sources/use-source-specs', async (original) => ({
  ...(await original<typeof import('@src/components/data-sources/use-source-specs')>()),
  useSourceSpecs: () => ({
    specs: hoisted.specs,
    specFor: (name: string) => (hoisted.specs as { name: string }[]).find((s) => s.name === name),
  }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: hoisted.project }) }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@src/components/quick-create/QuickCreatePanel', () => ({
  TILE_TIP_DELAY: 0,
  TileSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DesktopTile: ({ label, onClick, ...rest }: { label: string; onClick: () => void }) => (
    <button type="button" onClick={onClick} {...rest}>
      {label}
    </button>
  ),
}));

import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { TooltipProvider } from '@src/components/ui/tooltip';

const ID = '33333333-3333-4333-8333-333333333333';
const PROJECT = new Project({ id: '44444444-4444-4444-8444-444444444444', name: 'acme' } as never);
const ME = new TypeId(User.type, ID);

afterEach(() => {
  cleanup();
  hoisted.hub = false;
  vi.restoreAllMocks();
});

/** Opens the add form of `driver` and returns the spy on what the save is scoped to. */
function addForm(driver: 'chat' | 'feed', { project = PROJECT as Project | null, owner = ME } = {}) {
  hoisted.project = project;
  hoisted.specs = [
    new DataDriver({ name: 'chat', title: 'Chat', sends: true, listed: true } as never),
    new DataDriver({ name: 'feed', title: 'Feed', sends: false, listed: true } as never),
  ];
  const save = vi.spyOn(DataSource.prototype, 'save').mockResolvedValue(undefined as never);
  render(
    <TooltipProvider>
      <DataSourceDialog open onOpenChange={vi.fn()} owner={owner} />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByTestId(`provider-${driver}`));
  fireEvent.change(screen.getByLabelText(/Data source name/), { target: { value: 'mine' } });
  return save;
}

const add = () => fireEvent.click(screen.getByRole('button', { name: /^Add/ }));
const savedInto = async (save: ReturnType<typeof addForm>) => {
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  return (save.mock.calls[0][0] as TypeId[]).map(String);
};

it.each([
  ['chat', 'user', []],
  ['feed', 'project', [PROJECT.typeId.toString()]],
] as const)('a %s starts on %s', async (driver, starts, scope) => {
  const save = addForm(driver);
  expect(screen.getByTestId('ds-scope')).toHaveAttribute('data-scope', starts);
  add();
  expect(await savedInto(save)).toEqual(scope);
});

it('saves a channel into the project only when Project is picked', async () => {
  const save = addForm('chat');
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  add();
  expect(await savedInto(save)).toEqual([PROJECT.typeId.toString()]);
});

it('offers only Me when no project is open', async () => {
  const save = addForm('feed', { project: null });
  expect(screen.getByTestId('ds-scope')).toHaveAttribute('data-scope', 'user');
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  expect(screen.getByTestId('ds-scope')).toHaveAttribute('data-scope', 'user');
  add();
  expect(await savedInto(save)).toEqual([]);
});

it.each([
  ["an agent's source: it goes with its agent", { owner: new TypeId(Agent.type, ID) }, false],
  ['the hub: there is no project folder to save into', {}, true],
] as const)('does not ask for %s', async (_why, options, hub) => {
  hoisted.hub = hub;
  const save = addForm('feed', options);
  expect(screen.queryByTestId('ds-scope')).toBeNull();
  add();
  expect(await savedInto(save)).toEqual([]);
});
