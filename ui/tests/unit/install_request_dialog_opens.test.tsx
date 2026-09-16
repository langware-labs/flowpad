import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionManager } from '@sdk';
import { AddAssetDialogRoot } from '@src/components/install/AddAssetDialog';
import { installRequestStore } from '@src/components/install/install-request-store';
import { useUiCommandListener } from '@src/hooks/use-ui-command-listener';

const OTHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SKILL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mocks = vi.hoisted(() => ({
  installPublished: vi.fn(),
  openDisplayTarget: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  class Project {
    static type = 'project';
    id: string;
    constructor(json: { id: string }) {
      this.id = json.id;
    }
    installPublished = mocks.installPublished;
  }
  return {
    ...actual,
    Project,
    dataContext: { ...actual.dataContext, get project() { return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'pubdemo-2' }; } },
  };
});
vi.mock('@src/hooks/use-claude-projects', () => ({
  useProjectList: () => ({ projects: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'other', cwd: '/x/other' }], isLoading: false }),
  getProjectDisplayName: (p: { name: string }) => p.name,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {}, currentDock: null }) }));
vi.mock('@src/navigation/open-display-target', () => ({ openDisplayTarget: mocks.openDisplayTarget }));
vi.mock('@src/notifications', () => ({ notify: { success: mocks.success, error: mocks.error } }));
vi.mock('@src/notifications/renderDesktopNotification', () => ({ renderDesktopNotification: vi.fn() }));

const REQUEST = {
  request_id: 'r1',
  typeid: `skill-${SKILL_ID}`,
  type: 'skill',
  name: 'rca',
  description: 'Root cause analyzer',
  rel_path: '.claude/skills/rca',
  published_at: '2026-09-09T00:00:00Z',
  origin: { kind: 'local', base: '/p/.claude/skills', rel_path: 'rca' },
  source_project_id: OTHER_ID,
  source_project_name: 'pubdemo',
};

function Harness() {
  useUiCommandListener();
  return <AddAssetDialogRoot />;
}

/** Deliver a backend broadcast through the real WebSocket message handler. */
function broadcastUiCommand(fields: Record<string, unknown>) {
  ConnectionManager.getInstance().onMessage({ message_type: 'ui_command', message_id: crypto.randomUUID(), ...fields } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  installRequestStore.close();
});
afterEach(cleanup);

describe('install_request ui_command → Add asset dialog', () => {
  it('opens the dialog with the row, the active project preselected', async () => {
    render(<Harness />);
    expect(screen.queryByTestId('add-asset-dialog')).not.toBeInTheDocument();

    broadcastUiCommand({ kind: 'install_request', request: REQUEST });

    await waitFor(() => expect(installRequestStore.useStore.getState().open).toBe(true));
    expect(await screen.findByTestId('add-asset-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('add-asset-name')).toHaveTextContent('rca');
    expect(screen.getByTestId('add-asset-project')).toHaveTextContent('pubdemo-2');
  });

  it('Install calls the desk action for the chosen project and opens what the backend chose', async () => {
    mocks.installPublished.mockResolvedValue({ installed: {}, show: { kind: 'entity', typeid: REQUEST.typeid }, posix_path: '/p2/.claude/skills/rca', id: SKILL_ID });
    render(<Harness />);
    broadcastUiCommand({ kind: 'install_request', request: REQUEST });
    await screen.findByTestId('add-asset-dialog');

    await userEvent.click(screen.getByTestId('add-asset-install'));

    await waitFor(() => expect(mocks.installPublished).toHaveBeenCalledWith(REQUEST, false));
    expect(mocks.openDisplayTarget).toHaveBeenCalled();
    expect(installRequestStore.useStore.getState().open).toBe(false);
  });

  it('an "exists" refusal offers Replace, which retries with overwrite', async () => {
    const refusal = Object.assign(new Error('already in this project'), { response: { data: { data: { code: 'exists' } } } });
    mocks.installPublished.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ installed: {}, show: null, posix_path: '', id: SKILL_ID });
    render(<Harness />);
    broadcastUiCommand({ kind: 'install_request', request: REQUEST });
    await screen.findByTestId('add-asset-dialog');

    await userEvent.click(screen.getByTestId('add-asset-install'));
    expect(await screen.findByTestId('add-asset-error')).toHaveTextContent(/already in this project/);
    await userEvent.click(screen.getByTestId('add-asset-overwrite'));
    await waitFor(() => expect(mocks.installPublished).toHaveBeenLastCalledWith(REQUEST, true));
  });

  it('a frame without a typeid opens nothing', () => {
    render(<Harness />);
    broadcastUiCommand({ kind: 'install_request', request: { name: 'x' } });
    expect(installRequestStore.useStore.getState().open).toBe(false);
  });
});
