/**
 * The repo picker's owner select: you, the orgs GitHub reports, and every owner already in the list —
 * picking one filters to it. An org that restricts third-party apps never appears in GitHub's list,
 * however much the person belongs to it, so "Other organization…" asks for it by name, and an org
 * that shows nothing says why and where to grant access.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ orgRepos: vi.fn() }));
vi.mock('@src/hooks/use-git-providers', () => ({
  useGitRepos: () => ({
    data: [repo('langware-labs', 'flowpad'), repo('ZSchool-contact', 'teachpal-zone')],
    isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false,
  }),
  useGitOrgs: () => ({ data: { login: 'serans1', orgs: [{ login: 'langware-labs', avatar_url: '' }] } }),
  useGitOrgRepos: (_provider: string, owner: string) => h.orgRepos(owner),
}));

import { RepoPicker } from '@src/components/git/RepoPicker';

function repo(owner: string, name: string) {
  return {
    provider: 'github', owner, name, full_name: `${owner}/${name}`, private: true, default_branch: 'main',
    pushed_at: '2026-09-29T00:00:00Z', role: 'write', html_url: '', description: '', fork: false,
    git_origin: { provider: 'github', owner, name, branch: 'main', rel_path: '.' },
  };
}

beforeAll(() => {
  // Radix Select measures and scrolls in ways jsdom does not implement.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  h.orgRepos.mockReset();
});

async function pickOwner(label: string) {
  await userEvent.click(screen.getByTestId('repo-picker-owner'));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

describe('RepoPicker owner select', () => {
  it('offers you, your orgs and the owners in the list, and filters to the one picked', async () => {
    h.orgRepos.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    render(<RepoPicker provider="github" onSelect={vi.fn()} />);

    await userEvent.click(screen.getByTestId('repo-picker-owner'));
    const names = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['All owners', 'serans1', 'langware-labs', 'ZSchool-contact', 'Other organization…']);
    await userEvent.click(screen.getByRole('option', { name: 'ZSchool-contact' }));

    expect(screen.getByTestId('repo-picker-row-ZSchool-contact/teachpal-zone')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-picker-row-langware-labs/flowpad')).not.toBeInTheDocument();
    expect(h.orgRepos).toHaveBeenLastCalledWith('');
  });

  it('asks for an org the list does not hold by name, and lists its repos', async () => {
    h.orgRepos.mockImplementation((owner: string) =>
      owner === 'thinkz-team'
        ? { data: { owner, repos: [repo('thinkz-team', 'spora')], restricted: false }, isLoading: false, isError: false }
        : { data: undefined, isLoading: false, isError: false },
    );
    render(<RepoPicker provider="github" onSelect={vi.fn()} />);

    await pickOwner('Other organization…');
    fireEvent.change(screen.getByTestId('repo-picker-other-owner'), { target: { value: 'thinkz-team' } });
    await userEvent.click(screen.getByRole('button', { name: 'Show repos' }));

    expect(screen.getByTestId('repo-picker-row-thinkz-team/spora')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-picker-restricted')).not.toBeInTheDocument();
  });

  it('says an org that shows nothing most likely restricts third-party apps, and where to grant access', async () => {
    h.orgRepos.mockImplementation((owner: string) =>
      owner
        ? { data: { owner, repos: [], restricted: true }, isLoading: false, isError: false }
        : { data: undefined, isLoading: false, isError: false },
    );
    render(<RepoPicker provider="github" onSelect={vi.fn()} />);

    await pickOwner('Other organization…');
    fireEvent.change(screen.getByTestId('repo-picker-other-owner'), { target: { value: 'thinkz-team' } });
    await userEvent.click(screen.getByRole('button', { name: 'Show repos' }));

    const notice = screen.getByTestId('repo-picker-restricted');
    expect(notice).toHaveTextContent('Flowpad can’t see any of thinkz-team’s repos');
    expect(within(notice).getByRole('link')).toHaveAttribute('href', 'https://github.com/settings/applications');
    expect(notice.className).toContain('text-foreground');
  });
});
