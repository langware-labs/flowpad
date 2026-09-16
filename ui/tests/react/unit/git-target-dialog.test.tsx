/**
 * The git-target chooser asks WHICH remote and WHICH branch.
 *
 * The behavior worth pinning is that the user's answer reaches the caller
 * intact: an existing remote submits as `{mode:'existing', url, branch}`, and a
 * branch the user did not pick is ABSENT rather than defaulted — the flow this
 * replaced pushed a project to a brand-new public repo on `main` without ever
 * asking, and a silent default here would put that behavior straight back.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GitTargetDialog, type GitTarget } from '@src/components/git/GitTargetDialog';

// The chooser's own pickers talk to GitHub; this stands in for them with the
// two things the dialog actually consumes — a URL and a branch.
vi.mock('@src/components/git/GitRemoteField', () => ({
  GitRemoteField: ({
    value,
    onChange,
  }: {
    value: { url: string; branch: string | null };
    onChange: (next: { url: string; branch: string | null }) => void;
  }) => (
    <div>
      <input
        data-testid="fake-url"
        value={value.url}
        onChange={(e) => onChange({ url: e.target.value, branch: value.branch })}
      />
      <button data-testid="fake-branch" onClick={() => onChange({ url: value.url, branch: 'release/v2' })}>
        pick branch
      </button>
    </div>
  ),
}));

function show() {
  const onSubmit = vi.fn<(target: GitTarget) => Promise<void>>().mockResolvedValue(undefined);
  render(
    <GitTargetDialog
      open
      onOpenChange={() => {}}
      title="Set up Git"
      description="Give this project a Git remote."
      submitLabel="Set up Git"
      nameSeed="my-project"
      testIdPrefix="project-git-setup"
      awaitSubmit
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

const submit = () => fireEvent.click(screen.getByTestId('project-git-setup-submit'));

describe('GitTargetDialog', () => {
  it('submits the picked remote and branch', async () => {
    const onSubmit = show();
    fireEvent.change(screen.getByTestId('fake-url'), { target: { value: 'https://github.com/o/r.git' } });
    fireEvent.click(screen.getByTestId('fake-branch'));
    submit();
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'existing',
        url: 'https://github.com/o/r.git',
        branch: 'release/v2',
      }),
    );
  });

  it('omits the branch when the user did not pick one', async () => {
    const onSubmit = show();
    fireEvent.change(screen.getByTestId('fake-url'), { target: { value: 'https://github.com/o/r.git' } });
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({ mode: 'existing', url: 'https://github.com/o/r.git' });
  });

  it('cannot be submitted with no remote chosen', () => {
    const onSubmit = show();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('seeds the new-repo name from the project', async () => {
    const onSubmit = show();
    fireEvent.click(screen.getByTestId('project-git-setup-mode-new'));
    expect(screen.getByTestId<HTMLInputElement>('project-git-setup-name').value).toBe('my-project');
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ mode: 'new', name: 'my-project' }));
  });
});
