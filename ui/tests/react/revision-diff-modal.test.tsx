/**
 * RevisionDiffModal — two-tab compare. Verifies the Review tab is default, the
 * git-ops/show calls fetch both the past hash and HEAD, and switching to the
 * Code diff tab renders the (mocked) unified-diff viewer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { dataManager } from '@sdk';

// Stub the Monaco-based code diff so jsdom doesn't mount the editor.
vi.mock('@src/components/code-editor/DiffContent', () => ({
  DiffContent: ({ diffString }: { diffString: string }) => (
    <div data-testid="mock-diff-content">{diffString}</div>
  ),
}));

import { RevisionDiffModal } from '@src/components/assets/editor/revisions/RevisionDiffModal';

const NODE = '@local';
const WORKDIR = '/repo';
const FILE = 'SKILL.md';
const HASH = 'abc1234';
const OLD = '# Title\n\nThe quick cat sat.';
const NEW = '# Title\n\nThe quick dog sat.';

describe('RevisionDiffModal', () => {
  beforeEach(() => vi.restoreAllMocks());

  function mockGit() {
    return vi.spyOn(dataManager, 'callAction').mockImplementation(async (action: any) => {
      if (action.subpath === 'show') {
        return { content: action.queryParameters.hash === 'HEAD' ? NEW : OLD } as any;
      }
      if (action.subpath === 'revision-diff') return { diff: '@@ -1 +1 @@\n-cat\n+dog' } as any;
      return null as any;
    });
  }

  it('defaults to the Review tab and fetches old + HEAD via show', async () => {
    const spy = mockGit();
    render(
      <RevisionDiffModal open computeNodeId={NODE} workdir={WORKDIR} filepath={FILE} hash={HASH} version={3} onClose={() => {}} />,
    );

    // Review (markdown) is the default surface.
    await waitFor(() => expect(screen.getByTestId('markdown-review-diff')).toBeInTheDocument());
    expect(screen.queryByTestId('mock-diff-content')).toBeNull();

    // show called for both the past hash and HEAD; revision-diff for the code tab.
    const shows = spy.mock.calls.map((c: any[]) => c[0]).filter((a) => a.subpath === 'show');
    const hashes = shows.map((a) => a.queryParameters.hash);
    expect(hashes).toContain(HASH);
    expect(hashes).toContain('HEAD');
    expect(spy.mock.calls.some((c: any[]) => c[0].subpath === 'revision-diff')).toBe(true);
  });

  it('switching to Code diff renders the unified-diff viewer', async () => {
    mockGit();
    render(
      <RevisionDiffModal open computeNodeId={NODE} workdir={WORKDIR} filepath={FILE} hash={HASH} version={3} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByTestId('markdown-review-diff')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('compare-tab-code'));
    await waitFor(() => expect(screen.getByTestId('mock-diff-content')).toBeInTheDocument());
  });
});
