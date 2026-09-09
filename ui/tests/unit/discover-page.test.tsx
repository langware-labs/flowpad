import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DiscoverPage from '@src/pages/discover-page/discover-page';

// Everything a `vi.mock` factory touches must be hoisted with it.
const mocks = vi.hoisted(() => ({
  PROJECT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  hubOnly: false,
  view: {
    manifest: { exists: true, schema: 1, requires: {}, rel_path: 'agentic-assets/project_manifest/project_manifest.json', typeid: null },
    rows: [
      { typeid: `skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, type: 'skill', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'rca', description: 'root cause', rel_path: '.claude/skills/rca', published_at: '2026-09-09T00:00:00Z', state: 'in_use', posix_path: '/p/.claude/skills/rca', indexed: true },
    ],
    unpublished: [
      { typeid: `markdown-cccccccc-cccc-4ccc-8ccc-cccccccccccc`, type: 'markdown', name: 'guide', posix_path: '/p/docs/guide.md', project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ],
  },
}));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => mocks.hubOnly }));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({ ...(await importOriginal<typeof import('@sdk/react/hooks')>()), useEntity: () => ({ data: null }) }));
vi.mock('@src/components/theme-toggle/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('react-router', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-router')>()), useNavigate: () => vi.fn() }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  const project = {
    id: mocks.PROJECT_ID,
    typeId: { type: 'project', id: mocks.PROJECT_ID },
    name: 'proj',
    fs_storage_mount_path: '/p',
    displayName: 'proj',
    getPublished: vi.fn(() => Promise.resolve(mocks.view)),
    unpublish: vi.fn(() => Promise.resolve([])),
  };
  return {
    ...actual,
    dataContext: { ...actual.dataContext, get project() { return project; } },
  };
});

beforeEach(() => {
  mocks.hubOnly = false;
});
afterEach(cleanup);

describe('DiscoverPage', () => {
  it('on the desk: a Published section with state chips and a Not-yet-published section', async () => {
    render(<DiscoverPage />);
    expect(await screen.findByText('rca')).toBeInTheDocument();
    const published = screen.getByTestId('discover-published');
    expect(published.querySelector('[data-state="in_use"]')).not.toBeNull();
    expect(published.querySelectorAll('[data-testid="discover-card"]')).toHaveLength(1);
    const candidates = screen.getByTestId('discover-unpublished');
    expect(candidates.querySelectorAll('[data-testid="discover-card"]')).toHaveLength(1);
    expect(screen.getByText('guide')).toBeInTheDocument();
  });

  it('on the hub: only the Published section, nothing to toggle', async () => {
    mocks.hubOnly = true;
    render(<DiscoverPage />);
    expect(await screen.findByText('rca')).toBeInTheDocument();
    expect(screen.queryByTestId('discover-unpublished')).not.toBeInTheDocument();
    expect(screen.queryByTestId('published-toggle')).not.toBeInTheDocument();
    // The CLI form is on the page itself, not only behind Install.
    expect(screen.getByTestId('discover-copy-cli')).toBeInTheDocument();
  });
});
