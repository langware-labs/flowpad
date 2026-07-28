/**
 * The Git-readiness modal: what it shows, and which single action it offers.
 *
 * The behavior worth pinning is the ACTION choice. It is ordered by dependency
 * rather than by row order — offering to create a remote repository while the
 * tooling that would create it is missing sends the user down a path that
 * cannot work — so a capability failure must win even when the repo row also
 * failed.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectGitChecksDialog } from '@src/components/project-home/ProjectGitChecksDialog';
import type { GitCheck } from '@src/components/project-home/ProjectGitChip';

vi.mock('@src/journey/SetupJourneyButton', () => ({
  SETUP_GITHUB_JOURNEY_ID: 'journey-id',
  SetupJourneyButton: () => <button data-testid="setup-github">Set up GitHub</button>,
}));

const checks = (over: Partial<Record<GitCheck['id'], boolean | null>> = {}): GitCheck[] => [
  { id: 'installed', label: 'Git tooling installed', ok: over.installed ?? true, detail: null },
  { id: 'setup', label: 'Repository and remote configured', ok: over.setup ?? true, detail: null },
  { id: 'logged-in', label: 'Signed in to the remote', ok: over['logged-in'] ?? true, detail: null },
];

function show(list: GitCheck[], onSetupRepo = vi.fn().mockResolvedValue(undefined)) {
  render(
    <ProjectGitChecksDialog open onOpenChange={() => {}} checks={list} onSetupRepo={onSetupRepo} />,
  );
  return onSetupRepo;
}

describe('ProjectGitChecksDialog', () => {
  it('renders one row per check with its detail', () => {
    show([{ id: 'setup', label: 'Repository and remote configured', ok: false, detail: 'no remote' }]);
    expect(screen.getByTestId('git-check-setup')).toBeTruthy();
    expect(screen.getByText('no remote')).toBeTruthy();
  });

  it('offers the repo setup when only the repository is missing', () => {
    show(checks({ setup: false }));
    expect(screen.getByTestId('project-git-checks-setup-repo')).toBeTruthy();
    expect(screen.queryByTestId('setup-github')).toBeNull();
  });

  it('offers GitHub setup when the tooling is missing', () => {
    show(checks({ installed: false }));
    expect(screen.getByTestId('setup-github')).toBeTruthy();
  });

  it('prefers GitHub setup over repo setup when both failed', () => {
    // The dependency order: a repo cannot be published without the tooling.
    show(checks({ installed: false, setup: false }));
    expect(screen.getByTestId('setup-github')).toBeTruthy();
    expect(screen.queryByTestId('project-git-checks-setup-repo')).toBeNull();
  });

  it('offers nothing when every check passed', () => {
    show(checks());
    expect(screen.queryByTestId('setup-github')).toBeNull();
    expect(screen.queryByTestId('project-git-checks-setup-repo')).toBeNull();
  });

  it('treats an unreadable capability as unknown, not as a failure', () => {
    // A capability we could not read is not one we know to be missing — it must
    // not manufacture a "set up GitHub" prompt.
    show(checks({ installed: null }));
    expect(screen.queryByTestId('setup-github')).toBeNull();
  });
});
