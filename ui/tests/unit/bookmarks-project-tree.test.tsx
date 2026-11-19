import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bookmark, BookmarkType } from '@sdk';

/**
 * The bookmarks menu shows ONE LEVEL of the favorites tree at a time, named by
 * a breadcrumb. It opens at the open project; a project or folder is entered by
 * click, and the star crumb is the list of projects.
 *
 * The shape below is the real one read out of the `prod` instance
 * (2026-09-09, project 2a1e40da), folders renamed: `Work → Docs →
 * {agent-deployment, README}`.
 */
const PROJ = {
  current: '2a1e40da-9221-4ea4-82f3-18a0928a4654',
  other: '3d7e0743-0aab-40bf-9c41-962d3798eb07',
};
const ID = {
  work: '00000000-0000-4000-8000-000000000001',
  documents: '00000000-0000-4000-8000-000000000002',
  agentDeployment: '00000000-0000-4000-8000-000000000003',
  readme: '00000000-0000-4000-8000-000000000004',
  otherWork: '00000000-0000-4000-8000-000000000011',
  otherDoc: '00000000-0000-4000-8000-000000000012',
  personalDoc: '00000000-0000-4000-8000-000000000021',
};

const markdownLeaf = (id: string, title: string, parent: string, project?: string) =>
  new Bookmark({
    id,
    bookmark_type: BookmarkType.FAVORITE,
    title,
    parent_id: parent,
    project_id: project,
    data: {
      entity_type: 'markdown',
      entity_id: id,
      icon: 'FileText',
      nav: { asset_ref: `/x/${title}.md` },
    },
  });

const h = vi.hoisted(() => ({ bookmarks: [] as unknown[], currentProjectId: '' }));

h.bookmarks = [
  new Bookmark({
    id: ID.work,
    bookmark_type: BookmarkType.FAVORITE_FOLDER,
    title: 'Work',
    project_id: PROJ.current,
  }),
  new Bookmark({
    id: ID.documents,
    bookmark_type: BookmarkType.FAVORITE_FOLDER,
    title: 'Docs',
    parent_id: ID.work,
    project_id: PROJ.current,
  }),
  markdownLeaf(ID.agentDeployment, 'agent-deployment', ID.documents, PROJ.current),
  markdownLeaf(ID.readme, 'README', ID.documents, PROJ.current),
  new Bookmark({
    id: ID.otherWork,
    bookmark_type: BookmarkType.FAVORITE_FOLDER,
    title: 'Work',
    project_id: PROJ.other,
  }),
  markdownLeaf(ID.otherDoc, 'sources-and-sinks', ID.otherWork, PROJ.other),
  // No project_id at all — every favorite written before project stamping.
  markdownLeaf(ID.personalDoc, 'old-note', '', undefined),
];

vi.mock('@src/hooks/use-project-bookmarks', () => ({
  useProjectBookmarks: () => ({ data: h.bookmarks, refetch: vi.fn() }),
}));
vi.mock('@sdk/react/hooks', () => ({
  // The adapter reads dataContext (synchronous, so the first level is the open
  // project's); `use-favorites` fetches the entity to stamp new rows.
  useContext: () => ({ project: { id: h.currentProjectId } }),
  useProject: () => ({ project: { id: h.currentProjectId, displayName: 'flowpad-oss' } }),
}));
// Stable across renders, as the real hooks' results are.
const PROJECTS = [
  { id: PROJ.current, displayName: 'flowpad-oss' },
  { id: PROJ.other, displayName: 'test-project' },
];
const NO_SUMMARIES = {};
vi.mock('@src/hooks/entity-hooks', () => ({ useEntitiesQuery: () => ({ data: PROJECTS }) }));
vi.mock('@src/hooks/use-favorite-summaries', () => ({
  useFavoriteSummaries: () => NO_SUMMARIES,
  summaryForBookmark: () => undefined,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ activeEntity: null, activeEntityTypeId: null }),
}));
vi.mock('@src/components/asset-manager/AssetManagerPopover', () => ({
  AssetManagerPopover: () => null,
}));
vi.mock('@src/components/graph-view/icons/iconRegistry', () => ({
  iconForType: () => () => null,
  labelForType: (t: string) => t,
}));
vi.mock('@src/tabs/use-tab-manager', () => ({ useOpenTabHashes: () => new Set<string>() }));

const { FavoritesTreeMenu } = await import('@src/components/favorites/FavoritesTreeMenu');

/** The menu with the header slot its breadcrumb is drawn into, as the panel hosts it. */
function Panel() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      <div ref={setSlot} data-testid="header" />
      <FavoritesTreeMenu breadcrumbSlot={slot} />
    </>
  );
}

const header = () => screen.getByTestId('header').textContent;

/** Row labels + "ADD" markers in visual order — the level as the user reads it.
 *  The label is the truncating span (never the badge that follows it). */
function panelOrder(): string[] {
  const nodes = document.querySelectorAll('[data-browseable-id], [aria-label="New folder"]');
  return Array.from(nodes).map((el) =>
    el.getAttribute('aria-label') === 'New folder'
      ? 'ADD'
      : (el.querySelector('span.truncate')?.textContent ?? '').trim(),
  );
}

beforeEach(() => { h.currentProjectId = PROJ.current; });
afterEach(cleanup);

describe('bookmarks menu — one level at a time, under a breadcrumb', () => {
  it('opens at the open project: its rows and its add row, the other projects out of the way', async () => {
    render(<Panel />);
    await waitFor(() => expect(panelOrder()).toEqual(['ADD', 'Work']));
    expect(header()).toBe('flowpad-oss');
    expect(screen.queryByText('test-project')).toBeNull();
  });

  it('enters a folder on click, and a crumb goes back up', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByText('Work'));
    await waitFor(() => expect(panelOrder()).toEqual(['ADD', 'Docs']));
    await user.click(screen.getByText('Docs'));
    // Each level carries its own add row — it files into the folder shown.
    await waitFor(() => expect(panelOrder()).toEqual(['ADD', 'agent-deployment', 'README']));
    expect(header()).toBe('flowpad-ossWorkDocs');

    await user.click(within(screen.getByTestId('header')).getByText('Work'));
    await waitFor(() => expect(panelOrder()).toEqual(['ADD', 'Docs']));
  });

  it('lists the projects under the star crumb; only a level that can take a row offers one', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(await screen.findByLabelText('All bookmarks'));
    // The project list owns no bookmarks, so nothing can be filed into it.
    await waitFor(() => expect(panelOrder()).toEqual(['flowpad-oss', 'test-project', 'Personal']));
    expect(header()).toBe('Bookmarks');

    // A new row is stamped with the OPEN project, so one added directly on
    // another project's level would file into this one and vanish from view.
    await user.click(screen.getByText('test-project'));
    await waitFor(() => expect(panelOrder()).toEqual(['Work']));

    // A FOLDER inside it does offer one: it files into that folder by id.
    await user.click(screen.getByText('Work'));
    await waitFor(() => expect(panelOrder()).toEqual(['ADD', 'sources-and-sinks']));
  });

  it('an open project with no bookmarks opens on its own empty level, ready for its first row', async () => {
    h.currentProjectId = 'a-project-with-nothing-in-it';
    render(<Panel />);
    await waitFor(() => expect(screen.getByText('No bookmarks yet')).toBeTruthy());
    expect(panelOrder()).toEqual(['ADD']);
  });
});
