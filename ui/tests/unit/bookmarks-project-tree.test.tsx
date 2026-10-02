import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bookmark, BookmarkType } from '@sdk';

/**
 * The bookmarks menu is ONE GLOBAL tree grouped by project — no scope filter.
 * The current project is expanded on open; every other project holding
 * favorites is a sibling row you hover into.
 *
 * The shape below is the real one read out of the `prod` instance
 * (2026-09-09, project 2a1e40da), folders renamed: `Work → Docs →
 * {agent-deployment, README}`. That tree is also what produced the bug this file pins: with the
 * level footer rendered LAST, three open levels stacked three identical
 * unlabelled "add" rows at the bottom of the panel, which read as three empty
 * bookmarks.
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
  // The adapter reads dataContext (synchronous, seeds defaultExpandedIds on the
  // first render); `use-favorites` fetches the entity to stamp new rows.
  useContext: () => ({ project: { id: h.currentProjectId } }),
  useProject: () => ({ project: { id: h.currentProjectId, displayName: 'flowpad-oss' } }),
}));
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({
    data: [
      { id: PROJ.current, displayName: 'flowpad-oss' },
      { id: PROJ.other, displayName: 'test_flowpad' },
    ],
  }),
}));
vi.mock('@src/hooks/use-favorite-summaries', () => ({
  useFavoriteSummaries: () => ({}),
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

const bucket = (projectId: string) => `favproject:${projectId}`;
const addRows = () => screen.queryAllByLabelText('New folder').map((b) => b.closest('div') as HTMLElement);

/** Row labels + "ADD" markers in visual order — the panel as the user reads it.
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

describe('bookmarks tree — global, grouped by project', () => {
  it('opens on the current project and offers the others as siblings', async () => {
    render(<FavoritesTreeMenu mirrored />);

    // The current project is expanded already: its Work folder is on screen
    // without a single click.
    await waitFor(() => expect(screen.getByText('flowpad-oss')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Work')).toBeTruthy());

    // The other project and the unscoped desk are rows, not a filter mode.
    expect(screen.getByText('test_flowpad')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
    // ...and the current project leads.
    const buckets = Array.from(document.querySelectorAll('[data-browseable-id^="favproject:"]')).map((e) =>
      e.getAttribute('data-browseable-id'),
    );
    expect(buckets[0]).toBe(bucket(PROJ.current));
    expect(buckets).toContain(bucket(PROJ.other));

    // Hovering another project enters it the same way — same folder chevron,
    // same tree beneath it, all the way down to its leaves.
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`browseable-chevron-${bucket(PROJ.other)}`));
    await waitFor(() => expect(screen.getByTestId(`browseable-chevron-${ID.otherWork}`)).toBeTruthy());
    await user.click(screen.getByTestId(`browseable-chevron-${ID.otherWork}`));
    await waitFor(() => expect(screen.getByText('sources-and-sinks')).toBeTruthy());
  });

  it('never stacks add rows: one per level, leading the level it files into', async () => {
    const user = userEvent.setup();
    render(<FavoritesTreeMenu mirrored />);
    await waitFor(() => expect(screen.getByText('Work')).toBeTruthy());

    // Current project open: exactly ONE add row, directly under its bucket.
    expect(addRows()).toHaveLength(1);
    expect(panelOrder().slice(0, 3)).toEqual(['flowpad-oss', 'ADD', 'Work']);

    // Open both nested folders — the exact prod state that produced the three
    // anonymous rows. Each new level adds its own footer, and each sits at the
    // HEAD of its level, so no two are ever adjacent.
    await user.click(screen.getByTestId(`browseable-chevron-${ID.work}`));
    await waitFor(() => expect(screen.getByText('Docs')).toBeTruthy());
    await user.click(screen.getByTestId(`browseable-chevron-${ID.documents}`));
    await waitFor(() => expect(screen.getByText('README')).toBeTruthy());

    expect(panelOrder()).toEqual([
      'flowpad-oss',
      'ADD',
      'Work',
      'ADD',
      'Docs',
      'ADD',
      'agent-deployment',
      'README',
      'test_flowpad',
      'Personal',
    ]);
  });

  it('offers no add row on the project list, nor directly under a foreign project', async () => {
    const user = userEvent.setup();
    render(<FavoritesTreeMenu mirrored />);
    await waitFor(() => expect(screen.getByText('test_flowpad')).toBeTruthy());

    // The tree root is the project LIST — it owns no bookmarks, so nothing can
    // be filed into it.
    expect(panelOrder()[0]).not.toBe('ADD');

    // A bucket's own level maps to the real root parent (''), and a new row is
    // stamped with the CURRENT project — so an add row hanging directly off
    // someone else's desk would file into this one and disappear from view.
    await user.click(screen.getByTestId(`browseable-chevron-${bucket(PROJ.other)}`));
    await waitFor(() => expect(screen.getByTestId(`browseable-chevron-${ID.otherWork}`)).toBeTruthy());
    expect(panelOrder()).toEqual(['flowpad-oss', 'ADD', 'Work', 'test_flowpad', 'Work', 'Personal']);

    // A FOLDER inside it does offer one: it files into that folder by id, and
    // bucketing follows the top-level ancestor, so the new row lands exactly
    // where it was added.
    await user.click(screen.getByTestId(`browseable-chevron-${ID.otherWork}`));
    await waitFor(() => expect(screen.getByText('sources-and-sinks')).toBeTruthy());
    expect(panelOrder()).toEqual([
      'flowpad-oss',
      'ADD',
      'Work',
      'test_flowpad',
      'Work',
      'ADD',
      'sources-and-sinks',
      'Personal',
    ]);
  });

  it('shows no empty desk for a project with no favorites — the add row leads the tree instead', async () => {
    h.currentProjectId = 'a-project-with-nothing-in-it';
    render(<FavoritesTreeMenu mirrored />);

    // No synthesized bucket: an empty project desk read as an empty folder. The
    // first bookmark files from the tree-root add row (stamped with the current
    // project, so it opens that project's bucket once it exists).
    await waitFor(() => expect(addRows()).toHaveLength(1));
    expect(panelOrder().slice(0, 2)).toEqual(['ADD', 'flowpad-oss']);
    expect(screen.queryByText('Other project')).toBeNull();
    expect(screen.getByText('test_flowpad')).toBeTruthy();
  });

  it('with nothing bookmarked anywhere, the empty tree still offers the add row', async () => {
    const all = h.bookmarks;
    h.bookmarks = [];
    try {
      render(<FavoritesTreeMenu mirrored />);
      await waitFor(() => expect(screen.getByText('No bookmarks yet')).toBeTruthy());
      expect(addRows()).toHaveLength(1);
    } finally {
      h.bookmarks = all;
    }
  });

  it('a project bucket is a section, not a folder', async () => {
    render(<FavoritesTreeMenu mirrored />);
    await waitFor(() => expect(screen.getByText('flowpad-oss')).toBeTruthy());
    const row = document.querySelector(`[data-browseable-id="${bucket(PROJ.current)}"] [role="treeitem"]`)!;
    expect(row.className).toContain('font-medium');
    expect(row.className).toContain('text-muted-foreground');
  });

  it('lays the add row out on the tree axis so its level indent is visible', async () => {
    render(<FavoritesTreeMenu mirrored />);
    await waitFor(() => expect(screen.getByText('Work')).toBeTruthy());
    const [row] = addRows();
    // Mirrored: the row reverses with the tree, otherwise BrowseableTree's
    // trailing-edge indent lands on a leading-first row and every level draws
    // at the same x — which is how nested add rows became indistinguishable.
    expect(row.className).toContain('flex-row-reverse');
    expect((row.parentElement as HTMLElement).style.marginInlineEnd).not.toBe('');
    expect((row.parentElement as HTMLElement).style.marginInlineStart).toBe('');
  });
});
