/**
 * The `hub_repo` origin — a published asset in its project's HUB-HOSTED git
 * repository (backend `HubRepoOrigin`). Pins the SDK boundary (normalize,
 * label, guard) and that it never produces a provider web link: there is no
 * GitHub page for a repo that lives on the hub.
 */
import { describe, expect, it } from 'vitest';
import { formatFSOrigin, isGitOrigin, isHubRepoOrigin, normalizeFSOrigin, type HubRepoOrigin } from '@sdk';
import { projectOriginOf } from '@sdk/models/FSOrigin';
import { assetGitLinkFor } from '@src/hooks/use-asset-git-link';

const HUB: HubRepoOrigin = {
  kind: 'hub_repo',
  repo: 'git_repo-77777777-6666-4555-8444-333333333333',
  rel_path: '.claude/skills/rca',
  head_commit: 'b'.repeat(40),
  tree: 'c'.repeat(40),
};

describe('hub_repo origin', () => {
  it('survives the wire boundary with its kind', () => {
    const normalized = normalizeFSOrigin({ ...HUB, kind: 'HUB_REPO' as 'hub_repo' });
    expect(normalized).toEqual(HUB);
    expect(isHubRepoOrigin(normalized)).toBe(true);
    expect(isGitOrigin(normalized)).toBe(false);
  });

  it('is labelled by its path on the hub, never by its opaque repo id', () => {
    expect(formatFSOrigin(HUB)).toBe('hub · .claude/skills/rca');
    expect(formatFSOrigin({ ...HUB, rel_path: '.' })).toBe('hub');
  });

  it('has no provider web link', () => {
    expect(assetGitLinkFor(HUB, true)).toEqual({ url: null, repoLabel: null });
  });

  it('still links a GitHub origin to its page', () => {
    const git = {
      kind: 'git' as const,
      provider: 'github',
      owner: 'acme',
      name: 'tools',
      branch: 'main',
      head_commit: null,
      rel_path: '.claude/skills/rca',
    };
    expect(assetGitLinkFor(git, true)).toEqual({
      url: 'https://github.com/acme/tools/tree/main/.claude/skills/rca',
      repoLabel: 'acme/tools',
    });
    expect(assetGitLinkFor(null, false)).toEqual({ url: null, repoLabel: null });
  });
});

describe('projectOriginOf — what a shared project can be checked out from', () => {
  it('takes a git repo root or the hub-hosted copy, nothing else', () => {
    const hub = { kind: 'hub_repo', repo: 'git_repo-1', rel_path: '.' } as const;
    expect(projectOriginOf({ git_origin: hub })).toEqual(hub);
    expect(projectOriginOf({ origin: { kind: 'git', provider: 'github', owner: 'o', name: 'n', rel_path: '' } })?.kind).toBe('git');
    expect(projectOriginOf({ origin: { kind: 'hub_repo', repo: '', rel_path: '.' } })).toBeNull();
    expect(projectOriginOf({ origin: { kind: 'local', base: '/x', rel_path: '' } })).toBeNull();
  });
});
