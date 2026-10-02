import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { normalizeWorkerType } from '@src/components/workers/worker-types';
import { VibeWorkerSelect } from '@src/pages/flow-page/vibe-worker-select';

const h = vi.hoisted(() => ({ record: null as unknown }));

// The status record says what is installed; `null` is "not read yet", which fails open.
vi.mock('@src/components/status/use-status-record', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useStatusRecord: () => ({ status: h.record, isLoading: false }),
}));

/**
 * The select navigates on a warned pick, so every render needs a Router. With no status
 * record read yet nothing is known, which fails open — no warnings, no navigation, the plain
 * switcher behaviour below.
 */
function renderSelect(ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={['/dock/shell']}>{ui}</MemoryRouter>);
}

// The unit tier's setup carries no RTL auto-cleanup (unlike the react tier), so
// unmount between cases or the next getByTestId sees two mounted selects.
afterEach(cleanup);

// Radix Select opens through pointer capture and keeps the active item in view;
// jsdom implements neither, so without these the dropdown never opens. Same
// reason top-nav-search.test.tsx stubs scrollIntoView for cmdk.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

describe('VibeWorkerSelect', () => {
  it('shows Claude by default', () => {
    renderSelect(<VibeWorkerSelect value={undefined} onChange={vi.fn()} />);

    expect(screen.getByTestId('vibe-worker-select')).toHaveTextContent('Worker');
    expect(screen.getByTestId('vibe-worker-select')).toHaveTextContent('Claude');
    expect(normalizeWorkerType(undefined)).toBe('claude_code');
  });

  it('emits normalized worker ids', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderSelect(<VibeWorkerSelect value="claude_code" onChange={onChange} />);
    await user.click(screen.getByTestId('vibe-worker-select'));
    await user.click(await screen.findByTestId('vibe-worker-option-codex'));

    expect(onChange).toHaveBeenCalledWith('codex');
  });

  it('maps old worker aliases back to launchable worker ids', () => {
    expect(normalizeWorkerType('claude')).toBe('claude_code');
    expect(normalizeWorkerType('claude_code')).toBe('claude_code');
    expect(normalizeWorkerType('codex')).toBe('codex');
    expect(normalizeWorkerType('copilot')).toBe('copilot');
  });

  it('renders no warning badge when nothing is known about the harnesses', async () => {
    const user = userEvent.setup();

    renderSelect(<VibeWorkerSelect value="claude_code" onChange={vi.fn()} />);
    await user.click(screen.getByTestId('vibe-worker-select'));

    await screen.findByTestId('vibe-worker-option-copilot');
    expect(screen.queryByTestId('opener-warning-copilot')).toBeNull();
  });
});

/**
 * FLOWPAD-1976: a harness that failed its capability check must not be a
 * reachable move target — it carries the shared `OpenerWarningBadge` and routes
 * to Capabilities instead of switching the chat onto a harness that isn't there.
 */
describe('VibeWorkerSelect — unavailable harness', () => {
  const UNAVAILABLE = 'Copilot is not installed on this machine.';

  beforeEach(() => {
    // The record as the backend serves it after the boot sweep: Copilot's CLI is absent.
    h.record = {
      harnesses: [
        ['claude', 'Claude'],
        ['codex', 'Codex'],
        ['copilot', 'Copilot'],
        ['opencode', 'OpenCode'],
      ].map(([w, label]) => ({
        kind: `harness.${w}.cli`,
        worker_type: w,
        label,
        install: w === 'copilot' ? 'not_installed' : 'installed',
      })),
      keys: [],
      hub: { login: 'signed_out' },
      default_harness: 'harness.claude.cli',
    };
  });

  afterEach(() => {
    h.record = null;
  });

  function renderWithCopilotMissing() {
    const seen = { pathname: '', search: '' };
    const Probe = () => {
      const location = useLocation();
      seen.pathname = location.pathname;
      seen.search = location.search;
      return null;
    };
    const onChange = vi.fn();
    render(
      <MemoryRouter initialEntries={['/dock/shell']}>
        <Routes>
          <Route
            path="/dock/:viewType"
            element={
              <>
                <Probe />
                <VibeWorkerSelect value="claude_code" onChange={onChange} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    return { onChange, seen };
  }

  it('badges the harness, blocks the move, and opens Capabilities for that kind', async () => {
    const user = userEvent.setup();
    const { onChange, seen } = renderWithCopilotMissing();

    await user.click(screen.getByTestId('vibe-worker-select'));
    const copilot = await screen.findByTestId('vibe-worker-option-copilot');

    expect(copilot).toHaveAttribute('data-warning', 'true');
    expect(copilot).toHaveAttribute('title', UNAVAILABLE);
    expect(screen.getByTestId('opener-warning-copilot')).toBeInTheDocument();

    await user.click(copilot);

    // The move never happens...
    expect(onChange).not.toHaveBeenCalled();
    // ...the user lands on Capabilities, scoped so it re-probes THIS harness.
    expect(seen.pathname).toBe('/dock/capabilities');
    expect(seen.search).toContain('capability=harness.copilot.cli');
  });

  it('leaves an available harness switchable', async () => {
    const user = userEvent.setup();
    const { onChange } = renderWithCopilotMissing();

    await user.click(screen.getByTestId('vibe-worker-select'));
    const codex = await screen.findByTestId('vibe-worker-option-codex');

    expect(codex).not.toHaveAttribute('data-warning');
    await user.click(codex);

    expect(onChange).toHaveBeenCalledWith('codex');
  });
});
