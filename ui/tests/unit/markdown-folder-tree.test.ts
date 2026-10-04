/**
 * Unit tests for ``childrenForPrefix`` — the pure logic that turns the flat,
 * gitignore-aware project walk (``/assets/markdown-files``) into the Markdown
 * menu's folder tree.
 *
 * Regression: a project-ROOT ``.md`` (``streams_sdk.md``) must appear as a
 * top-level leaf of the vault, not be dropped because the menu only walked
 * ``docs/``. Also covers folder grouping, folders-before-files ordering, and
 * lazy subfolder recursion over the same walk.
 */
import { describe, expect, it } from 'vitest';
import { childrenForPrefix, markdownFolderRoot } from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import { DEFAULT_ASSET_FILTER } from '@src/components/assets/assetFilter';
import { allScope, filterScope } from '@src/lib/scope-filter';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';

const VAULT_ABS = '/Users/me/proj';

function build(prefixRel: string, files: string[]) {
  return childrenForPrefix({
    typeName: 'markdown',
    typeid: 'compute_node-@local',
    vaultAbsPath: VAULT_ABS,
    vaultRelPath: VAULT_ABS.replace(/^\/+/, ''),
    files,
    prefixRel,
  });
}

const FILES = [
  'streams_sdk.md',                 // project-root file (the regression)
  'docs/STREAMS-ANALYSIS.md',
  'docs/whatsapp/hello.md',
  'experiments/x/README.md',
];

describe('childrenForPrefix', () => {
  it('surfaces a project-root .md as a top-level vault leaf', () => {
    const top = build('', FILES);
    const rootFile = top.find((n) => n.label === 'streams_sdk.md');
    expect(rootFile).toBeDefined();
    expect(rootFile!.kind).toBe('asset');
    expect(rootFile!.id).toBe(`md-file:compute_node-@local:${VAULT_ABS}/streams_sdk.md`);
  });

  it('groups subfolders and orders folders before files', () => {
    const top = build('', FILES);
    expect(top.map((n) => ({ label: n.label, kind: n.kind }))).toEqual([
      { label: 'docs', kind: 'folder' },
      { label: 'experiments', kind: 'folder' },
      { label: 'streams_sdk.md', kind: 'asset' },
    ]);
  });

  it('lists immediate children of a subfolder (file + nested folder)', () => {
    const docs = build('docs', FILES);
    expect(docs.map((n) => ({ label: n.label, kind: n.kind }))).toEqual([
      { label: 'whatsapp', kind: 'folder' },
      { label: 'STREAMS-ANALYSIS.md', kind: 'asset' },
    ]);
  });

  it('builds correct absolute paths for deeply nested files', () => {
    const deep = build('docs/whatsapp', FILES);
    expect(deep).toHaveLength(1);
    expect(deep[0].label).toBe('hello.md');
    expect(deep[0].id).toBe(`md-file:compute_node-@local:${VAULT_ABS}/docs/whatsapp/hello.md`);
  });

  it('returns nothing for an empty walk', () => {
    expect(build('', [])).toEqual([]);
  });
});

describe('markdownFolderRoot vault scoping', () => {
  const TYPE: AssetTypeInfo = {
    type_name: 'markdown',
    label: 'Documents',
    creatable: true,
    vaults: [
      { typeid: 'compute_node-@local', relPath: 'Users/me/a', absPath: '/Users/me/a', label: 'A', scope: 'project', project_id: 'pa' },
      { typeid: 'compute_node-@local', relPath: 'Users/me/b', absPath: '/Users/me/b', label: 'B', scope: 'project', project_id: 'pb' },
    ],
  } as AssetTypeInfo;

  const root = (scope: ReturnType<typeof allScope>) =>
    markdownFolderRoot(TYPE, { indexType: async () => {}, filter: { ...DEFAULT_ASSET_FILTER, scope } });

  // Regression (2026-10-03): the "All" scope selects no SPECIFIC project, so
  // keepVault dropped every project vault and the Documents root lost its chevron.
  it('the All scope keeps every vault', async () => {
    const r = root(allScope());
    expect(r.hasChildren).toBe(true);
    expect((await r.listChildren!()).map((n) => n.label)).toEqual(['A', 'B']);
  });

  it('a filter scope keeps only the selected project vaults', async () => {
    const r = root(filterScope(false, ['pb']));
    expect((await r.listChildren!()).map((n) => n.label)).toEqual(['B']);
  });
});
