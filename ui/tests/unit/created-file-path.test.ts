/**
 * Resolving a written path to something a dock pointer can actually open.
 *
 * THE assertion: a `FileWriteEntry.path` is a VENDOR path, not a VFS path —
 * absolute for Claude `Write`, cwd-relative for Codex `apply_patch`. Handing it
 * straight to the file dock pointer is the documented 404: the code editor has
 * no compute-node prefix to resolve against and falls back to the ambient
 * project root. Every case below is one shape that reaches the chips.
 */
import { describe, expect, it } from 'vitest';

import { TypeId } from '@sdk';
import { createdFileVfsPath } from '@src/components/floating-chat/createdFilePath';

const LOCAL = new TypeId('compute_node', '@local');
const REMOTE = new TypeId('compute_node', '11111111-0000-4000-8000-000000000001');

describe('createdFileVfsPath', () => {
  it('prefixes a POSIX absolute path with the compute node', () => {
    expect(createdFileVfsPath('/repo/src/new.ts', { locator: LOCAL })).toBe('compute_node-@local/repo/src/new.ts');
  });

  it('drops the drive and flips the separators on a Windows absolute path', () => {
    expect(createdFileVfsPath('C:\\Users\\a\\new.ts', { locator: LOCAL })).toBe('compute_node-@local/Users/a/new.ts');
  });

  it('anchors a Codex-relative path on the process workdir', () => {
    expect(createdFileVfsPath('docs/hello.md', { workdir: '/repo', locator: LOCAL })).toBe(
      'compute_node-@local/repo/docs/hello.md',
    );
  });

  it('anchors a Codex-relative path on a Windows workdir', () => {
    expect(createdFileVfsPath('docs/hello.md', { workdir: 'C:\\repo', locator: LOCAL })).toBe(
      'compute_node-@local/repo/docs/hello.md',
    );
  });

  it('strips a leading ./ from a relative path', () => {
    expect(createdFileVfsPath('./docs/hello.md', { workdir: '/repo', locator: LOCAL })).toBe(
      'compute_node-@local/repo/docs/hello.md',
    );
  });

  it('lets a VFS-shaped workdir pick the node, over the ambient locator', () => {
    // The agent ran where its workdir says it ran. A process on a remote node
    // must not resolve against whatever node the browser is looking at.
    expect(
      createdFileVfsPath('docs/hello.md', { workdir: `${REMOTE.toString()}/repo`, locator: LOCAL }),
    ).toBe(`${REMOTE.toString()}/repo/docs/hello.md`);
  });

  it('honours a remote locator for an absolute path', () => {
    expect(createdFileVfsPath('/repo/a.ts', { locator: REMOTE })).toBe(`${REMOTE.toString()}/repo/a.ts`);
  });

  it('resolves nothing for a relative path with no workdir', () => {
    // Better an inert chip than one that opens the wrong file.
    expect(createdFileVfsPath('docs/hello.md', { locator: LOCAL })).toBeNull();
    expect(createdFileVfsPath('docs/hello.md', { workdir: '', locator: LOCAL })).toBeNull();
    expect(createdFileVfsPath('docs/hello.md', { workdir: 'not/absolute', locator: LOCAL })).toBeNull();
  });

  it('resolves nothing for an empty path', () => {
    expect(createdFileVfsPath('', { workdir: '/repo', locator: LOCAL })).toBeNull();
  });
});
