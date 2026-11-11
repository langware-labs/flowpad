import { describe, expect, it } from 'vitest';
import { gitConnectionRequired, needsGitConnection } from '@src/components/assets/editor/git-connection';

describe('needsGitConnection', () => {
  it('asks for git when a hub-read git type has no origin', () => {
    expect(needsGitConnection(true, 'git', {})).toBe(true);
  });
  it('does not ask once the entity has an origin', () => {
    expect(needsGitConnection(true, 'git', { origin: { kind: 'hub_repo' } })).toBe(false);
    expect(needsGitConnection(true, 'git', { git_origin: { kind: 'git' } })).toBe(false);
  });
  it('never asks on the desk or for embedded types', () => {
    expect(needsGitConnection(false, 'git', {})).toBe(false);
    expect(needsGitConnection(true, 'embedded', {})).toBe(false);
    expect(needsGitConnection(true, 'git', null)).toBe(false);
  });
});

describe('gitConnectionRequired', () => {
  const linked = { git_origin: { provider: 'github' } };

  it('is the unlinked case too', () => {
    expect(gitConnectionRequired(true, 'git', {}, 0)).toBe(true);
  });

  it('is a linked git asset whose record/refs the hub answered 404 (the git source is unreachable)', () => {
    expect(gitConnectionRequired(true, 'git', linked, 404)).toBe(true);
  });

  it('is not any other record failure, a readable asset, a non-git type or a local read', () => {
    expect(gitConnectionRequired(true, 'git', linked, 500)).toBe(false);
    expect(gitConnectionRequired(true, 'git', linked, 403)).toBe(false);
    expect(gitConnectionRequired(true, 'git', linked, 0)).toBe(false);
    expect(gitConnectionRequired(true, 'blob', linked, 404)).toBe(false);
    expect(gitConnectionRequired(false, 'git', linked, 404)).toBe(false);
  });
});
