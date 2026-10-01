/**
 * The repo picker's owner picker — ONE control: you, the orgs GitHub reports and every owner already
 * in the list, searchable; picking one filters to it. An org that restricts third-party apps never
 * appears in GitHub's list, however much the person belongs to it, so typing a name the list does not
 * hold asks for that org's repos, and an org that shows nothing says why and where to grant access.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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

async function openOwners() {
  await userEvent.click(screen.getByTestId('repo-picker-owner'));
  return screen.findByTestId('repo-picker-owner-search');
}

describe('RepoPicker owner picker', () => {
  it('offers you, your orgs and the owners in the list, and filters to the one picked', async () => {
    h.orgRepos.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    render(<RepoPicker provider="github" onSelect={vi.fn()} />);

    await openOwners();
    const names = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['All owners', 'serans1', 'langware-labs', 'ZSchool-contact']);
    await userEvent.click(screen.getByRole('option', { name: 'ZSchool-contact' }));

    expect(screen.getByTestId('repo-picker-owner')).toHaveTextContent('ZSchool-contact');
    expect(screen.getByTestId('repo-picker-row-ZSchool-contact/teachpal-zone')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-picker-row-langware-labs/flowpad')).not.toBeInTheDocument();
    expect(h.orgRepos).toHaveBeenLastCalledWith('');
  });

  it('is one control: typing an org the list does not hold asks for its repos', async () => {
    h.orgRepos.mockImplementation((owner: string) =>
      owner === 'acme-corp'
        ? { data: { owner, repos: [repo('acme-corp', 'api')], restricted: false }, isLoading: false, isError: false }
        : { data: undefined, isLoading: false, isError: false },
    );
    render(<RepoPicker provider="github" onSelect={vi.fn()} />);

    await userEvent.type(await openOwners(), 'acme-corp');
    await userEvent.click(screen.getByTestId('repo-picker-owner-typed'));

    expect(screen.getByTestId('repo-picker-row-acme-corp/api')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-picker-restricted')).not.toBeInTheDocument();
  });

  it('typing an owner already offered picks it, with no second "show repos of" row', async () => {
    h.orgRepos.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    render(<RepoPicker provider="github" onSelect={vi.fn()} />);

    await userEvent.type(await openOwners(), 'langware-labs');

    expect(screen.queryByTestId('repo-picker-owner-typed')).not.toBeInTheDocument();
  });

  it('says an org that shows nothing most likely restricts third-party apps, and where to grant access', async () => {
    h.orgRepos.mockImplementation((owner: string) =>
      owner
        ? { data: { owner, repos: [], restricted: true }, isLoading: false, isError: false }
        : { data: undefined, isLoading: false, isError: false },
    );
    render(<RepoPicker provider="github" onSelect={vi.fn()} />);

    await userEvent.type(await openOwners(), 'acme-corp');
    await userEvent.click(screen.getByTestId('repo-picker-owner-typed'));

    const notice = screen.getByTestId('repo-picker-restricted');
    expect(notice).toHaveTextContent('Flowpad can’t see any of acme-corp’s repos');
    expect(within(notice).getByRole('link')).toHaveAttribute('href', 'https://github.com/settings/applications');
    expect(notice.className).toContain('text-foreground');
  });
});
