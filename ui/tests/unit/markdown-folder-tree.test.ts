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
import { childrenForPrefix } from '@src/components/browseable-tree/adapters/markdownFolderRoot';

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
