/**
 * The "Harness is required" dialog — the one a failed launch raises.
 *
 * Two things it must get right, both reported from a real screen:
 *
 * The install command comes from the SUMMARY, never the capability row. The
 * summary derives it from the spec per request, so it cannot be stale or
 * absent; the row can be both — one seeded before the field existed carries
 * null, and a DB with duplicate rows for a kind can hand `useCapability` the
 * empty one. Either way the button vanished on exactly the machines that
 * needed it.
 *
 * And the verdict line carries the verdict's colour. Amber is a warning, and
 * every row wore it: a harness that PASSED its check looked identical to one
 * that had failed.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  snapshot: { capability: null as unknown, available: false, result: null as unknown, isLoading: false },
  summary: null as unknown,
  test: vi.fn(),
}));

vi.mock('@sdk/react/hooks', () => ({
  useCapability: () => ({ ...h.snapshot, resolvedKind: null, test: h.test }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openNewShell: vi.fn() }, currentDock: null }),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  capabilityManager: { getCachedSummary: () => h.summary, setReferenceKind: vi.fn() },
}));

import { AskInstallOneOfDialog } from '@src/components/terminal/openers/AskInstallOneOfDialog';

const CLAUDE = 'harness.claude.cli';
const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
/** A real row: the title falls back to the raw kind without one. */
const ROW = { name: 'Claude CLI', description: 'Claude Code command-line harness.', homepage_url: null };

function mount() {
  render(<AskInstallOneOfDialog kinds={[CLAUDE]} onClose={vi.fn()} />);
  const row = screen.getByTestId(`install-one-of-row-${CLAUDE}`);
  return { row, q: within(row) };
}

describe('AskInstallOneOfDialog', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.snapshot = { capability: ROW, available: false, result: null, isLoading: false };
    h.summary = { capabilities: [{ kind: CLAUDE, install_command: INSTALL }] };
  });

  it('does not execute a harness probe while the controller keeps it closed', () => {
    render(<AskInstallOneOfDialog kinds={null} onClose={vi.fn()} />);

    expect(screen.queryByTestId('install-one-of-dialog')).toBeNull();
  });

  it('offers the install command even when the capability row does not carry it', () => {
    // The reported case: the row carries no command, the summary is authoritative.
    h.snapshot = { capability: { ...ROW, install_command: null }, available: false, result: null, isLoading: false };

    const { q } = mount();

    expect(q.getByTestId(`install-one-of-auto-${CLAUDE}`)).toBeTruthy();
  });

  it('offers nothing when the platform has no unattended installer', () => {
    h.summary = { capabilities: [{ kind: CLAUDE, install_command: null }] };

    const { q } = mount();

    expect(q.queryByTestId(`install-one-of-auto-${CLAUDE}`)).toBeNull();
  });

  it('does not offer to install a harness that is already there', () => {
    h.snapshot = { capability: ROW, available: true, result: null, isLoading: false };

    const { q } = mount();

    expect(q.queryByTestId(`install-one-of-auto-${CLAUDE}`)).toBeNull();
  });

  it('shows a passing check in green and a failing one in amber', () => {
    h.snapshot = { capability: ROW, available: true, result: { message: 'claude CLI test passed.' }, isLoading: false };
    expect(mount().q.getByText('claude CLI test passed.').className).toContain('emerald');

    cleanup();
    h.snapshot = {
      capability: ROW,
      available: false,
      result: { message: 'claude CLI was not found in PATH.' },
      isLoading: false,
    };
    expect(mount().q.getByText('claude CLI was not found in PATH.').className).toContain('amber');
  });

  it('drops the kind and description lines that were not actionable', () => {
    // The name stays; the raw kind and the spec blurb do not. Neither was
    // clickable and neither told a reader which assistant to choose.
    const { q } = mount();

    expect(q.getByText('Claude CLI')).toBeTruthy();
    expect(q.queryByText(CLAUDE)).toBeNull();
    expect(q.queryByText(ROW.description)).toBeNull();
  });
});
