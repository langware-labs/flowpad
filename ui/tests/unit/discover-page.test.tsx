import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DiscoverPage from '@src/pages/discover-page/discover-page';

// Everything a `vi.mock` factory touches must be hoisted with it.
const mocks = vi.hoisted(() => ({
  PROJECT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  hubOnly: false,
  openDiscoverAsset: vi.fn(),
  openDiscover: vi.fn(),
  getPublishedDirectory: vi.fn(),
  view: {
    manifest: { exists: true, schema: 1, requires: {}, rel_path: 'agentic-assets/project_manifest/project_manifest.json', typeid: null },
    rows: [
      { typeid: `skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, type: 'skill', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'rca', description: 'root cause', rel_path: '.claude/skills/rca', published_at: '2026-09-09T00:00:00Z', state: 'in_use', posix_path: '/p/.claude/skills/rca', indexed: true, origin: { kind: 'local' } },
    ],
    unpublished: [
      { typeid: `markdown-cccccccc-cccc-4ccc-8ccc-cccccccccccc`, type: 'markdown', name: 'guide', posix_path: '/p/docs/guide.md', project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ],
  },
  directory: {
    rows: [
      { typeid: `skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, type: 'skill', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'rca', description: 'root cause', rel_path: '.claude/skills/rca', published_at: '2026-09-09T00:00:00Z', state: 'install', origin: { kind: 'git', provider: 'github', owner: 'acme', name: 'tools', branch: 'main', rel_path: '.claude/skills/rca' }, source_project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source_project_name: 'alpha', body_supported: true, body_available: false, body_reason: 'not_on_hub', body_ref: null },
      { typeid: `markdown-dddddddd-dddd-4ddd-8ddd-dddddddddddd`, type: 'markdown', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'guide', description: '', rel_path: 'docs/guide.md', published_at: '2026-09-01T00:00:00Z', state: 'install', origin: { kind: 'local' }, source_project_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', source_project_name: 'beta', body_supported: true, body_available: false, body_reason: 'not_on_hub', body_ref: null },
    ],
    facets: { types: [], projects: [] },
    total: 2,
  },
}));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => mocks.hubOnly }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDiscoverAsset: mocks.openDiscoverAsset, openDiscover: mocks.openDiscover } }),
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({ ...(await importOriginal<typeof import('@sdk/react/hooks')>()), useEntity: () => ({ data: null }) }));
vi.mock('@src/components/theme-toggle/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  const project = {
    id: mocks.PROJECT_ID,
    typeId: { type: 'project', id: mocks.PROJECT_ID },
    name: 'proj',
    displayName: 'proj',
    getPublished: vi.fn(() => Promise.resolve(mocks.view)),
    unpublish: vi.fn(() => Promise.resolve([])),
  };
  class Project extends (actual.Project as unknown as { new (...args: unknown[]): object }) {
    static getPublishedDirectory = mocks.getPublishedDirectory;
  }
  return {
    ...actual,
    Project,
    dataContext: { ...actual.dataContext, get project() { return project; } },
  };
});

beforeEach(() => {
  mocks.hubOnly = false;
  mocks.getPublishedDirectory.mockReset();
  mocks.getPublishedDirectory.mockResolvedValue(mocks.directory);
});
afterEach(cleanup);

describe('DiscoverPage', () => {
  it('on the desk: ranked rows in a Published section and a Not-yet-published section', async () => {
    render(<DiscoverPage />);
    expect(await screen.findByText('rca')).toBeInTheDocument();
    const published = screen.getByTestId('discover-published');
    expect(published.querySelectorAll('[data-testid="discover-row"]')).toHaveLength(1);
    expect(published.querySelector('[data-testid="discover-row"]')?.getAttribute('data-state')).toBe('in_use');
    const candidates = screen.getByTestId('discover-unpublished');
    expect(candidates.querySelectorAll('[data-testid="discover-row"]')).toHaveLength(1);
    expect(screen.getByText('guide')).toBeInTheDocument();
    expect(screen.queryByTestId('discover-copy-cli')).not.toBeInTheDocument();
  });

  it('on the hub: the directory across projects, newest first, with Install and the CLI copy; the command block follows the hovered row', async () => {
    mocks.hubOnly = true;
    render(<DiscoverPage />);
    expect(await screen.findByText('rca')).toBeInTheDocument();
    expect(mocks.getPublishedDirectory).toHaveBeenCalled();
    expect(screen.queryByTestId('discover-unpublished')).not.toBeInTheDocument();
    expect(screen.queryByTestId('published-toggle')).not.toBeInTheDocument();
    const rows = screen.getAllByTestId('discover-row');
    expect(rows.map((r) => r.getAttribute('data-typeid'))).toEqual([
      'skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'markdown-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ]);
    expect(rows[0].textContent).toContain('1');
    expect(screen.getAllByTestId('discover-copy-cli')).toHaveLength(2);
    expect(screen.getByTestId('discover-provenance')).toHaveTextContent('acme/tools@main');
    expect(screen.getByText('alpha')).toBeInTheDocument();

    const block = screen.getByTestId('discover-command-block');
    expect(block).toHaveTextContent('uv tool install flowpad && flow start && flow auth login');
    fireEvent.mouseEnter(rows[0]);
    expect(block).toHaveTextContent('flow asset install skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    fireEvent.click(rows[0]);
    expect(mocks.openDiscoverAsset).toHaveBeenCalledWith('skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});
