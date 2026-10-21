import { describe, expect, it } from 'vitest';
import { needsGitConnection } from '@src/components/assets/editor/git-connection';

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
