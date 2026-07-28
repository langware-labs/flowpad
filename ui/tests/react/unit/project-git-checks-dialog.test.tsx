/**
 * The Git-readiness modal: what it shows, and the fix it puts on each row.
 *
 * The behavior worth pinning is that a fix belongs to the STEP it repairs — a
 * failing row carries its own button, and a row that passed or could not be
 * read carries none. The two capability rows share one journey but are labelled
 * for their own step, because "Signed in to the remote ✗ [Install gh]" would
 * name the wrong problem.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectGitChecksDialog } from '@src/components/project-home/ProjectGitChecksDialog';
import type { GitCheck } from '@src/components/project-home/ProjectGitChip';

vi.mock('@src/journey/SetupJourneyButton', () => ({
  SETUP_GITHUB_JOURNEY_ID: 'journey-id',
  // Renders its label so a test can tell WHICH step's button it is.
  SetupJourneyButton: ({ children }: { children?: React.ReactNode }) => (
    <button data-testid="setup-github">{children}</button>
  ),
}));

/** The fix button inside a given check's row, or null. */
function fixIn(id: GitCheck['id']): HTMLElement | null {
  return within(screen.getByTestId(`git-check-${id}`)).queryByRole('button');
}

const LABELS: Record<GitCheck['id'], string> = {
  installed: 'Git tooling installed',
  setup: 'Repository and remote configured',
  'logged-in': 'Signed in to the remote',
};

/** All three rows passing, with the named ones overridden. `in` rather than
 *  `??`, so an override of `null` (unknown) survives instead of collapsing to
 *  the `true` default — the distinction the unknown-state test exists to pin. */
const checks = (over: Partial<Record<GitCheck['id'], boolean | null>> = {}): GitCheck[] =>
  (Object.keys(LABELS) as GitCheck['id'][]).map((id) => ({
    id,
    label: LABELS[id],
    ok: id in over ? (over[id] as boolean | null) : true,
    detail: null,
  }));

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

  it('puts the fix on the failing row and nowhere else', () => {
    show(checks({ setup: false }));
    expect(fixIn('setup')?.dataset.testid).toBe('project-git-checks-setup-repo');
    expect(fixIn('installed')).toBeNull();
    expect(fixIn('logged-in')).toBeNull();
  });

  it('gives each failing step its own button, labelled for that step', () => {
    show(checks({ installed: false, 'logged-in': false, setup: false }));
    expect(fixIn('installed')?.textContent).toBe('Install gh');
    expect(fixIn('logged-in')?.textContent).toBe('Sign in');
    expect(fixIn('setup')?.textContent).toContain('Set up Git');
  });

  it('offers nothing when every check passed', () => {
    show(checks());
    for (const id of ['installed', 'setup', 'logged-in'] as const) expect(fixIn(id)).toBeNull();
  });

  it('treats an unreadable capability as unknown, not as a failure', () => {
    // A capability we could not read is not one we know to be missing — it must
    // not manufacture a fix button for a step that may be fine.
    show(checks({ installed: null }));
    expect(fixIn('installed')).toBeNull();
  });
});
