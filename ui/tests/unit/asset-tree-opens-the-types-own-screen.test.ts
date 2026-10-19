/**
 * An asset whose type has its own screen and no asset editor opens THAT screen from the
 * Assets tree — the one a search result opens. It used to open the plain code editor pointed
 * at the asset's folder: an empty buffer beside a file list.
 */
import { describe, expect, it, vi } from 'vitest';

const projectSchemas = vi.hoisted(() => vi.fn());
vi.mock('@sdk', async (importOriginal) => ({ ...(await importOriginal<typeof import('@sdk')>()), projectSchemas }));

import { buildAssetChild } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import { openBrowseable } from '@src/components/browseable-tree/open';
import { ViewType } from '@src/types/ViewType';

const ID = '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c';
const PROJECT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function row(type: string, extra: Record<string, unknown> = {}) {
  return { record_id: ID, record_type: type, name: 'thing', asset_ref: `/p/agentic-assets/${type}/thing`, ...extra } as never;
}

describe('the asset tree opens a type on its own screen', () => {
  it.each([
    ['graph_workflow', ViewType.GRAPH_WORKFLOWS],
    ['trigger', ViewType.AUTOMATIONS],
  ])('%s opens its screen, not its folder', (type, view) => {
    const node = buildAssetChild(type, row(type), true, 'root');
    expect(node.pointer?.viewType).toBe(view);
  });

  it('a data schema opens on its project schema tree, selected by its full kind', async () => {
    projectSchemas.mockResolvedValue({ schemas: [{ kind: '--demo--.navigation.outcome', name: 'navigation.outcome' }] });
    const node = buildAssetChild('data_schema', row('data_schema', { name: 'navigation.outcome', project_id: PROJECT }), true, 'root');
    const navigate = vi.fn();
    expect(openBrowseable(node, navigate)).toBe(true);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const dock = navigate.mock.calls[0][0];
    expect(projectSchemas).toHaveBeenCalledWith(PROJECT);
    expect(dock.viewType).toBe(ViewType.SCHEMA_TREE);
    expect(dock.pointer).toBe('--demo--.navigation.outcome');
  });

  it('a help desk opens its project portal', () => {
    const node = buildAssetChild('helpdesk', row('helpdesk', { project_id: PROJECT }), true, 'root');
    expect(node.pointer?.viewType).toBe(ViewType.HELPDESK);
    expect(node.pointer?.pointer).toBe(PROJECT);
  });

  it.each(['asset_setup', 'compute_op'])('%s opens its own viewer, not the code editor', (type) => {
    const node = buildAssetChild(type, row(type), true, 'root');
    expect(node.pointer?.viewType).toBe(ViewType.ASSETS);
    expect(node.pointer?.pointer).toContain(`editor/${type}/`);
  });

  it('an editor-backed type keeps its asset-editor pointer', () => {
    const node = buildAssetChild('agent', row('agent'), true, 'root');
    expect(node.pointer?.viewType).toBe(ViewType.ASSETS);
  });
});
