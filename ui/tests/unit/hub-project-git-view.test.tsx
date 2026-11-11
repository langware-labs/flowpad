/** The hub project Git view: branches, who has access and recent commits, from what the hub answers. */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { hubProjectGitDock, isProjectGitSub } from '@src/lib/hub-page-url';
import { AccessCard, BranchesCard, CommitsCard } from '@src/pages/hub-project/HubProjectGitView';
import { participantLabel } from '@src/components/conversation/participant-display';

afterEach(cleanup);

const SHA = 'a'.repeat(40);

describe('hub project git view', () => {
  it('lists branches with their last commit and marks the default', () => {
    render(
      <BranchesCard
        defaultBranch="main"
        branches={[
          { name: 'feature', sha: SHA, author: 'Ada', date: '2026-11-10T10:00:00Z', subject: 'add three' },
          { name: 'main', sha: SHA, author: 'Ada', date: '2026-11-01T10:00:00Z', subject: 'add two' },
        ]}
      />,
    );
    expect(screen.getByText(/Branches · 2/)).toBeInTheDocument();
    expect(screen.getByTestId('project-git-branch-main')).toHaveTextContent('default');
    expect(screen.getByTestId('project-git-branch-feature')).not.toHaveTextContent('default');
    expect(screen.getByText('add three')).toBeInTheDocument();
    expect(screen.getAllByText('aaaaaaa')).toHaveLength(2);
  });

  it('says how to start when there are no branches', () => {
    render(<BranchesCard defaultBranch="main" branches={[]} />);
    expect(screen.getByText(/the first push creates main/)).toBeInTheDocument();
  });

  it('shows every member with their role', () => {
    render(
      <AccessCard
        members={[
          { user_id: 'u1', name: 'Eran', roles: ['owner'] },
          { user_id: 'u2', email: 'gadi@example.com', roles: ['reader'] },
        ]}
      />,
    );
    expect(screen.getByText(/Who has access · 2/)).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.getByText(participantLabel({ email: 'gadi@example.com' }))).toBeInTheDocument();
  });

  it('lists commits newest first as given', () => {
    render(
      <CommitsCard
        branch="main"
        commits={[
          { sha: SHA, author: 'Ada', date: '2026-11-10T10:00:00Z', subject: 'add two' },
          { sha: 'b'.repeat(40), author: 'Ada', date: '2026-11-09T10:00:00Z', subject: 'add one' },
        ]}
      />,
    );
    expect(screen.getByText(/Recent commits on main/)).toBeInTheDocument();
    const subjects = screen.getAllByText(/^add /).map((el) => el.textContent);
    expect(subjects).toEqual(['add two', 'add one']);
  });

  it('addresses the view as the project sub-route git', () => {
    const dock = hubProjectGitDock('p1');
    const { projectId, assetSubPointer } = DockPointer.splitProjectPointer(dock.pointer);
    expect(projectId).toBe('p1');
    expect(isProjectGitSub(assetSubPointer)).toBe(true);
    expect(dock.toUrl()).toBe('/dock/hub/project/p1/git');
  });
});
