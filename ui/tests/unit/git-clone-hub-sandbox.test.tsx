/**
 * Where a clone lands, per runtime.
 *
 * Desk clones onto the local compute node. The hub has neither a compute node
 * (its bootstrap ships no `default_compute_node`) nor a local filesystem, so the
 * same dialog must target an E2B sandbox: `launch({sandboxProject})` has the HUB clone
 * the repo — with the user's token, which is the only reason a PRIVATE repo is
 * reachable at all — and copy the tree into the box.
 *
 * Before this, the hub path threw `No compute node available` after already
 * failing the access probe, so "Open from git" was a dead button there.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hubOnly: false,
  launch: vi.fn(() => Promise.resolve()),
}));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hubOnly }));
vi.mock('@src/hooks/use-sandboxes', () => ({ useSandboxes: () => ({ launch: h.launch }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

import { useGitCloneDialogSubmit } from '@src/components/project-selector/use-ensure-project';

const REPO_URL = 'https://github.com/langware-labs/flowpad-hub.git';

function mount(computeNodeId: string | null) {
  const captured: { current: ReturnType<typeof useGitCloneDialogSubmit> | null } = { current: null };
  const Probe = () => {
    captured.current = useGitCloneDialogSubmit(computeNodeId);
    return null;
  };
  render(<Probe />);
  return captured;
}

describe('clone target, by runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.hubOnly = false;
  });
  afterEach(() => cleanup());

  it('on hub, clones into an E2B sandbox — no compute node needed', async () => {
    h.hubOnly = true;
    const submit = mount(null); // the hub genuinely has none

    await act(async () => {
      await submit.current!(REPO_URL, undefined, 'main');
    });

    expect(h.launch).toHaveBeenCalledTimes(1);
    const arg = h.launch.mock.calls[0][0] as {
      name: string;
      sandboxProject: { name: string; gitOrigin: { owner: string; name: string; branch: string } };
    };
    expect(arg.name).toBe('flowpad-hub');
    expect(arg.sandboxProject.gitOrigin.owner).toBe('langware-labs');
    expect(arg.sandboxProject.gitOrigin.name).toBe('flowpad-hub');
    // The picked branch has to reach the box, or it clones the default branch.
    expect(arg.sandboxProject.gitOrigin.branch).toBe('main');
  });

  it('on hub, refuses a URL it cannot turn into a git origin', async () => {
    h.hubOnly = true;
    const submit = mount(null);

    await expect(submit.current!('not a git url')).rejects.toThrow(/git URL/i);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('on desk, never launches a sandbox — it takes the compute-node path', async () => {
    const submit = mount('node-1');

    // The real compute-node clone cannot complete in jsdom; what matters here is
    // WHICH path was taken, so we only require that it wasn't the sandbox one.
    await act(async () => {
      await submit.current!(REPO_URL).catch(() => undefined);
    });

    expect(h.launch).not.toHaveBeenCalled();
  });

  it('on desk with no compute node, says so instead of silently doing nothing', async () => {
    const submit = mount(null);

    await expect(submit.current!(REPO_URL)).rejects.toThrow(/compute node/i);
    expect(h.launch).not.toHaveBeenCalled();
  });
});
