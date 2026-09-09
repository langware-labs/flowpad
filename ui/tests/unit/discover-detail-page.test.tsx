import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DiscoverDetailPage from '@src/pages/discover-page/DiscoverDetailPage';

const mocks = vi.hoisted(() => ({
  typeid: 'skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  getPublishedDirectory: vi.fn(),
  body: { fields: {}, body: '', bodyStartLine: 0, isLoading: false, loadError: null },
  row: (over: Record<string, unknown> = {}) => ({
    typeid: 'skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    type: 'skill',
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'rca',
    description: 'root cause',
    rel_path: '.claude/skills/rca',
    published_at: '2026-09-09T00:00:00Z',
    state: 'in_use',
    origin: { kind: 'git', provider: 'github', owner: 'acme', name: 'tools', branch: 'main', rel_path: '.claude/skills/rca', head_commit: 'a'.repeat(40) },
    source_project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    source_project_name: 'alpha',
    body_supported: true,
    body_available: true,
    body_reason: null,
    body_ref: { type_id: 'skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', path: 'SKILL.md' },
    ...over,
  }),
}));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => true }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDiscoverAsset: vi.fn(), openDiscover: vi.fn() } }) }));
vi.mock('@src/components/theme-toggle/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('@src/components/install/InstallButton', () => ({ InstallButton: () => <button data-testid="install-button">Install</button> }));
vi.mock('@src/hooks/use-markdown-content', () => ({ useMarkdownContent: () => mocks.body }));
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ typeid: mocks.typeid }),
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  class Project extends (actual.Project as unknown as { new (...args: unknown[]): object }) {
    static getPublishedDirectory = mocks.getPublishedDirectory;
  }
  return { ...actual, Project, dataContext: { ...actual.dataContext, get project() { return null; } } };
});

function directoryFor(rows: Record<string, unknown>[]) {
  mocks.getPublishedDirectory.mockImplementation((opts: { typeid?: string; project?: string } = {}) =>
    Promise.resolve({
      rows: rows.filter((r) => (!opts.typeid || r.typeid === opts.typeid) && (!opts.project || r.source_project_id === opts.project)),
      facets: { types: [], projects: [] },
      total: rows.length,
    }),
  );
}

beforeEach(() => {
  mocks.getPublishedDirectory.mockReset();
  mocks.body = { fields: {}, body: '', bodyStartLine: 0, isLoading: false, loadError: null };
});
afterEach(cleanup);

describe('DiscoverDetailPage (hub)', () => {
  it('renders the document body when the hub holds it, plus install command and siblings', async () => {
    mocks.body = { fields: { name: 'rca' }, body: '# rca\n\nQuote the first error line.', bodyStartLine: 4, isLoading: false, loadError: null };
    directoryFor([mocks.row(), mocks.row({ typeid: 'skill-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'sibling' })]);
    render(<DiscoverDetailPage />);
    expect(await screen.findByTestId('discover-detail-header')).toHaveTextContent('rca');
    expect(screen.getByTestId('discover-detail-body')).toHaveTextContent('Quote the first error line.');
    expect(screen.getByTestId('discover-detail-body')).not.toHaveTextContent('name: rca');
    expect(screen.getByTestId('discover-detail-install')).toHaveTextContent('flow asset install skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(screen.getByTestId('install-button')).toBeInTheDocument();
    expect(screen.getAllByTestId('discover-provenance')[0]).toHaveTextContent('acme/tools@main');
    const more = await screen.findByTestId('discover-more');
    expect(more.querySelectorAll('[data-testid="discover-row"]')).toHaveLength(1);
    expect(more).toHaveTextContent('sibling');
  });

  it('explains why the document is not on the hub', async () => {
    directoryFor([mocks.row({ state: 'install', body_available: false, body_reason: 'not_on_hub', body_ref: null })]);
    render(<DiscoverDetailPage />);
    expect(await screen.findByTestId('discover-body-reason')).toHaveTextContent('Connect GitHub on the publishing desk');
  });

  it('says so when nothing visible matches the id', async () => {
    directoryFor([]);
    render(<DiscoverDetailPage />);
    expect(await screen.findByTestId('discover-not-found')).toBeInTheDocument();
  });
});
