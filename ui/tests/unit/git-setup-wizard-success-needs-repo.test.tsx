/**
 * The git setup wizard reports success only when the REPO is set up, not when
 * the wizard agent merely ends. The `git-dependency` agent can end with
 * `status: 'done'` while the folder still has no usable origin (e.g. `gh` is
 * missing and it stops to ask for a remote URL). The wizard must re-ask
 * `git_share_preflight` and stay out of "Git is set up." while it still
 * returns a needs-setup code.
 * Spec: tests/manual_regression/assets/deploy_git_setup_false_success.md
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/git/GitRemoteField', () => ({
  GitRemoteField: ({ testIdPrefix }: { testIdPrefix?: string }) => (
    <button data-testid={`${testIdPrefix}-connect-github`}>Connect</button>
  ),
}));
vi.mock('@src/components/project-home/ProjectCloudLinkButton', () => ({
  ProjectCloudLinkButton: () => <button data-testid="cloud-link">link</button>,
}));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: null }) }));
const launchWizard = vi.hoisted(() => vi.fn());
const callAction = vi.hoisted(() => vi.fn());
const notifyError = vi.hoisted(() => vi.fn());
vi.mock('@src/notifications', () => ({ notify: { error: notifyError, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, launchWizard, dataManager: { callAction } };
});

import { TypeId, type Project } from '@sdk';
import { GitRequiredStrip } from '@src/components/git/GitRequiredStrip';

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const PROJECT = {
  id: PID,
  name: 'demo',
  remote: false,
  fs_storage_mount_path: '/w/demo',
  typeId: new TypeId('project', PID),
} as unknown as Project;

function preflight(code: string | null) {
  return { available: code === null, reason: code ? `reason for ${code}` : null, code, git_origin: null };
}

function runSetup() {
  render(<GitRequiredStrip project={PROJECT} />);
  fireEvent.click(screen.getByTestId('git-required-add'));
  fireEvent.click(screen.getByTestId('git-setup-mode-new'));
  fireEvent.change(screen.getByTestId('git-setup-name'), { target: { value: 'demo-repo' } });
  fireEvent.click(screen.getByTestId('git-setup-next'));
}

beforeEach(() => {
  launchWizard.mockReset().mockResolvedValue({ status: 'done' });
  callAction.mockReset();
  notifyError.mockReset();
});
afterEach(cleanup);

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.git_setup_false_success.rules: FAILING? the wizard agent's
//       status 'done' is NOT proof of a repo — GitSetupWizard runProjectGitSetup must
//       re-ask git_share_preflight and only report "Git is set up." when it no longer
//       returns a needs-setup code (not-in-repo / missing-remote / unsupported-origin).
// flowpad:endcapsule tag
describe('GitSetupWizard success needs a working repo', () => {
  it.each(['not-in-repo', 'missing-remote', 'unsupported-origin'])(
    'agent ends "done" but preflight still says %s → no "Git is set up", back to the picker with a notice',
    async (code) => {
      callAction.mockResolvedValue(preflight(code));
      runSetup();
      await waitFor(() => expect(notifyError).toHaveBeenCalled());
      expect(launchWizard).toHaveBeenCalledWith('git-dependency', expect.anything());
      expect(screen.queryByTestId('git-setup-done')).toBeNull();
      expect(screen.getByTestId('git-setup-mode-new')).toBeTruthy(); // back on the picker
      expect(String(notifyError.mock.calls[0][0].message)).toMatch(/did not finish/);
    },
  );

  it('agent ends "done" and preflight is clear → "Git is set up."', async () => {
    callAction.mockResolvedValue(preflight(null));
    runSetup();
    await waitFor(() => expect(screen.getByTestId('git-setup-done')).toBeTruthy());
    expect(notifyError).not.toHaveBeenCalled();
  });
});
