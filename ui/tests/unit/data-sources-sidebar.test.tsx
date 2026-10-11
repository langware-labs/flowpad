import { useEffect, useMemo } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DataSource } from '@sdk';
import { BrowseableRoot } from '@src/components/browseable-tree/types';
import { useBrowseableTree } from '@src/components/browseable-tree/useBrowseableTree';
import { subscribeRefresh } from '@src/components/browseable-tree/refresh-store';
import { useDataSourcesRoot } from '@src/components/browseable-tree/adapters/dataSourcesRoot';

let sources: DataSource[] = [];
const specFor = () => undefined;
vi.mock('@src/hooks/entity-hooks', () => ({ useEntitiesQuery: () => ({ data: sources }) }));
vi.mock('@src/components/data-sources/use-source-specs', () => ({
  sourcesQuery: {},
  useSourceSpecs: () => ({ specFor }),
}));

function Rows({ root }: { root: BrowseableRoot }) {
  const roots = useMemo(() => [root], [root]);
  const tree = useBrowseableTree(roots);
  useEffect(() => subscribeRefresh((id) => { void tree.invalidate(id); }), [tree]);
  return <>
    <button onClick={() => void tree.toggleExpand(root)}>{root.label}</button>
    {tree.getChildren(root.id).map((row) => <a key={row.id} href={row.pointer?.toUrl()}>{row.label}</a>)}
  </>;
}
function Sidebar() {
  const root = useDataSourcesRoot();
  return root ? <Rows root={root} /> : null;
}
const source = (id: string, displayName: string) => ({ id, displayName, provider: '', channel: '' }) as DataSource;

it('adds and removes the source category and refreshes already expanded children', async () => {
  const { rerender } = render(<Sidebar />);
  expect(screen.queryByRole('button')).toBeNull();
  sources = [source('10000000-0000-4000-8000-000000000001', 'Support mail')];
  rerender(<Sidebar />);
  act(() => screen.getByRole('button').click());
  expect((await screen.findByRole('link', { name: 'Support mail' })).getAttribute('href')).toContain('/data-sources/10000000-0000-4000-8000-000000000001');
  sources = [source('10000000-0000-4000-8000-000000000002', 'Archive')];
  rerender(<Sidebar />);
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Support mail' })).toBeNull());
  expect(screen.getByRole('link', { name: 'Archive' })).toBeTruthy();
  sources = [];
  rerender(<Sidebar />);
  expect(screen.queryByRole('button')).toBeNull();
});
