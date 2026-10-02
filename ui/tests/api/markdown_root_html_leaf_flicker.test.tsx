/**
 * The Documents side menu must not blank a project's docs folder back to
 * "Loading…" while a NON-markdown file of that folder is open ("open the html
 * in sapora, the side menu flickers", 2026-10-02).
 *
 * Real path, no mocks: a real Project over a fresh directory holding one `.md`
 * and one `.html`, the backend's own asset catalog vaults (`/assets/types`), the
 * real Markdown root (`markdownFolderRoot`, which lists the vault through the
 * backend's `/assets/markdown-files` walk) and the real tree hook
 * (`useBrowseableTree`). `BrowseableTree` re-runs `expandParentsForPointer` for
 * the open file on every roots-identity change, so the test runs that walk
 * twice, the way re-renders do, over an already-expanded vault, and counts the
 * vault re-listings (each one first resets the folder to "Loading…").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { ComputeNode, Project, apiClient, type AssetCatalog } from '@sdk';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownFolderNodeId, markdownFolderRoot } from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import { useBrowseableTree } from '@src/components/browseable-tree/useBrowseableTree';
import { projectScope } from '@src/lib/scope-filter';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';
import { apiTestSetup, getTestSignupInfo, trackCreatedRows } from '../utils/test-utils';

describe('the Documents tree with a non-markdown file open', () => {
  const signupInfo = getTestSignupInfo();
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mdhtmlleaf'));
  const { created: cleanupProjects } = trackCreatedRows(Project.type);

  beforeEach(async (ctx: any) => {
    await apiTestSetup(signupInfo, ctx.task.name);
  });

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  /** With the vault expanded, walk the real tree to `openName` twice; return how often the walks re-listed the vault. */
  async function relistsOnReRun(openName: string): Promise<number> {
    const project = await new Project({ name: projectDir }).save([]);
    cleanupProjects.push(project.id);

    const catalog = await apiClient.get<AssetCatalog>('/assets/types');
    const vaults = catalog?.types.find((t) => t.type_name === 'markdown')?.vaults ?? [];
    const vault = vaults.find((v) => v.absPath === projectDir);
    expect(vault, `no markdown vault for ${projectDir}`).toBeTruthy();

    const scope = projectScope(project.id);
    const root = markdownFolderRoot(
      { type_name: 'markdown', label: 'Documents', icon: 'FileText', vaults } as unknown as AssetTypeInfo,
      { indexType: async () => {}, filter: { query: '', scope, tags: [], filters: {} } },
    );
    const vaultId = markdownFolderNodeId(vault!.typeid, vault!.absPath);

    // The open file, as the loader settles it (explorer double-click → scoped Assets editor).
    const node = await ComputeNode.getLocal();
    const openFile = dockPointerForFile(`${node!.typeId.toString()}${path.join(projectDir, openName)}`).withScopeFilter(scope);

    // The side menu as the user has it: the project's docs folder expanded and listed.
    const { result } = renderHook(() => useBrowseableTree([root]));
    const vaultNode = (await root.listChildren!()).find((n) => n.id === vaultId)!;
    await act(async () => {
      await result.current.expand(vaultNode);
    });
    expect(result.current.getLoadState(vaultId).status).toBe('ready');

    // The walk to the open file that every re-render repeats. The vault is already
    // listed, so it must not be refetched — a refetch first resets it to
    // "Loading…". The spy only watches.
    const get = vi.spyOn(apiClient, 'get');
    for (let run = 0; run < 2; run++) {
      await act(async () => {
        await result.current.expandParentsForPointer(openFile);
      });
    }
    const relisted = get.mock.calls.filter(([url]) => String(url).includes('/assets/markdown-files')).length;
    get.mockRestore();
    return relisted;
  }

  beforeEach(() => {
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# readme\n');
    fs.writeFileSync(path.join(projectDir, 'report.html'), '<!doctype html><title>r</title>');
  });

  it('does not re-list the expanded vault while an .html file is open', async () => {
    expect(await relistsOnReRun('report.html'), 'vault re-listed on a re-run').toBe(0);
  });

  it('control: does not re-list the expanded vault while an .md file is open', async () => {
    expect(await relistsOnReRun('README.md'), 'vault re-listed on a re-run').toBe(0);
  });
});
