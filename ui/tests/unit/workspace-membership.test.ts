/**
 * Workspaces — a folder of related projects (`flow_sdk/builtin/workspace.py`).
 *
 * Membership is a location fact (the frontend twin of `workspace_id_for_path`), and
 * the ACTIVE workspace lives in the URL (`?workspace=<id>`): sticky across every
 * navigation, changed only by `navigation.openWorkspace`, and absent for the default
 * workspace — so every URL from before workspaces means what it meant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPathUnderRoot, resolveActiveWorkspace, workspaceDisplayName, workspaceForPath, type IWorkspace } from '@sdk';
import { DockPointer, WORKSPACE_PARAM } from '@src/navigation/DockPointer';
import { NavigationActions, STICKY_OPTION_PARAMS } from '@src/navigation/NavigationActions';

const DEFAULT: IWorkspace = { id: 'd0000000-0000-4000-8000-000000000000', name: 'Local Desktop Workspace', is_default: true };
const CLIENT: IWorkspace = {
  id: 'c0000000-0000-4000-8000-000000000000',
  name: 'Client X',
  is_default: false,
  root_path: '/Users/alice/Flowpad/Client X',
};
const WIN: IWorkspace = {
  id: 'e0000000-0000-4000-8000-000000000000',
  name: 'Win',
  is_default: false,
  root_path: 'C:/Users/alice/Flowpad/Win',
};

describe('workspace membership (by location)', () => {
  it('with only the default workspace, every path is the default one', () => {
    expect(workspaceForPath('/Users/alice/Flowpad workspace/a', [DEFAULT])).toBe(DEFAULT);
    expect(workspaceForPath('/Users/alice/Documents/dev/repo', [DEFAULT])).toBe(DEFAULT);
    expect(workspaceForPath(undefined, [DEFAULT])).toBe(DEFAULT);
  });

  it('a project inside a user-created root belongs to that workspace', () => {
    const all = [DEFAULT, CLIENT];
    expect(workspaceForPath('/Users/alice/Flowpad/Client X/site', all)).toBe(CLIENT);
    expect(workspaceForPath('/Users/alice/Flowpad workspace/a', all)).toBe(DEFAULT);
    // Segment-safe: a sibling that only starts like the root is not inside it.
    expect(workspaceForPath('/Users/alice/Flowpad/Client X2/site', all)).toBe(DEFAULT);
  });

  it('Windows paths compare case-insensitively, with either slash', () => {
    expect(isPathUnderRoot('c:\\users\\ALICE\\flowpad\\win\\site', 'C:/Users/alice/Flowpad/Win')).toBe(true);
    expect(workspaceForPath('C:\\Users\\alice\\Flowpad\\Win\\site', [DEFAULT, WIN])).toBe(WIN);
    // POSIX stays case-sensitive (APFS/ext4 paths are compared as stored).
    expect(isPathUnderRoot('/users/alice/flowpad/client x/site', '/Users/alice/Flowpad/Client X')).toBe(false);
  });

  it('the default workspace is shown as "Flowpad"', () => {
    expect(workspaceDisplayName(DEFAULT)).toBe('Flowpad');
    expect(workspaceDisplayName(CLIENT)).toBe('Client X');
    expect(workspaceDisplayName(undefined)).toBe('Flowpad');
  });
});

describe('resolveActiveWorkspace (shared by the hook and the loaders)', () => {
  it('with only the default workspace, nothing is scoped and everything belongs', () => {
    const r = resolveActiveWorkspace([DEFAULT], null);
    expect(r).toMatchObject({ workspace: DEFAULT, hasMany: false, scopeId: undefined });
    expect(r.contains('/anywhere/at/all')).toBe(true);
  });

  it('a named workspace scopes, and filters by location', () => {
    const r = resolveActiveWorkspace([DEFAULT, CLIENT], CLIENT.id);
    expect(r).toMatchObject({ workspace: CLIENT, hasMany: true, scopeId: CLIENT.id });
    expect(r.contains('/Users/alice/Flowpad/Client X/site')).toBe(true);
    expect(r.contains('/Users/alice/Flowpad workspace/a')).toBe(false);
  });

  it('a deleted, unknown or default id is the default workspace', () => {
    for (const id of ['e1111111-0000-4000-8000-000000000000', DEFAULT.id, null]) {
      const r = resolveActiveWorkspace([DEFAULT, CLIENT], id);
      expect(r.workspace).toBe(DEFAULT);
      expect(r.contains('/Users/alice/Flowpad workspace/a')).toBe(true);
      expect(r.contains('/Users/alice/Flowpad/Client X/site')).toBe(false);
    }
  });
});

describe('the active workspace in the URL', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  it('is a sticky option that never changes tab identity', () => {
    expect(STICKY_OPTION_PARAMS).toContain(WORKSPACE_PARAM);
    const plain = DockPointer.forHome();
    expect(plain.withOption(WORKSPACE_PARAM, CLIENT.id!).tabHash).toBe(plain.tabHash);
  });

  it('rides every navigation from inside a workspace', () => {
    window.history.pushState({}, '', `/dock/assets/list/all?${WORKSPACE_PARAM}=${CLIENT.id}`);
    const navigate = vi.fn();
    const navigation = new NavigationActions(navigate, null);
    navigation.openDock(DockPointer.forHome());
    expect(String(navigate.mock.calls.at(-1)?.[0])).toContain(`${WORKSPACE_PARAM}=${CLIENT.id}`);
  });

  it('openWorkspace switches it, and the default workspace clears it', () => {
    window.history.pushState({}, '', `/dock/assets/list/all?${WORKSPACE_PARAM}=${CLIENT.id}`);
    const navigate = vi.fn();
    const navigation = new NavigationActions(navigate, null);

    navigation.openWorkspace(WIN.id!);
    expect(String(navigate.mock.calls.at(-1)?.[0])).toContain(`${WORKSPACE_PARAM}=${WIN.id}`);

    navigation.openWorkspace(null);
    expect(String(navigate.mock.calls.at(-1)?.[0])).not.toContain(WORKSPACE_PARAM);
  });
});
