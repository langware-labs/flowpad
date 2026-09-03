/**
 * Harness device logins in the Connections table.
 *
 * Two things this file exists to pin. The row is about the harness's OWN login, so
 * it must be found among the candidate `sources` rather than taken from `resolved`
 * — otherwise a box where a stored API key outranks the device login would simply
 * stop showing that the harness is signed in at all. And the status word must never
 * claim more than the backend does: `login_state` does not survive a restart, so
 * "Not checked" is the common case, not an edge one.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  status: null as unknown,
  openLlmSources: vi.fn(),
  navigation: { marker: 'nav' },
}));

// The hook, not the service: `use-llm-sources` also exports `harnessKinds` and
// `workerOf`, so the mock must spread the original or the component loses them.
vi.mock('@src/components/llm-sources/use-llm-sources', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmSources: () => ({ status: h.status, isLoading: false }),
}));
vi.mock('@src/components/llm-sources/llm-sources-pointer', () => ({
  openLlmSources: h.openLlmSources,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: h.navigation }),
}));

const { HarnessConnectionRows } = await import(
  '@src/components/connections-manager/harness-connection-rows'
);

const DEVICE = 'llm_endpoint-device-claude';
const KEY = 'llm_endpoint-key-openrouter';

/** One harness, with both a device login and a stored key competing to fund it. */
function statusWith(device: Record<string, unknown>, resolvedTypeid = KEY) {
  return {
    sources: {
      'harness.claude.cli': [
        { endpoint_typeid: DEVICE, name: 'claude device login', detail: '', reason: '', eligible: true, auto: false, authority: 'presumed', rank: 0, origin: 'default', ...device },
        { endpoint_typeid: KEY, name: 'openrouter key', detail: '', reason: '', eligible: true, auto: true, authority: 'proven', rank: 10, origin: 'default' },
      ],
    },
    resolved: { 'harness.claude.cli': { endpoint_typeid: resolvedTypeid } },
    endpoints: {
      [DEVICE]: { kind: 'device' },
      [KEY]: { kind: 'api_key' },
    },
  };
}

const renderRows = () =>
  render(
    <table>
      <tbody>
        <HarnessConnectionRows />
      </tbody>
    </table>,
  );

describe('HarnessConnectionRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.status = statusWith({});
  });
  afterEach(() => cleanup());

  it('renders nothing on the hub, where device logins are not a fact', () => {
    // `llmSourcesService.status()` answers null off-desk by design, and that is
    // also what stops the row offering a Details link to a desk-only screen.
    h.status = null;
    const { container } = renderRows();
    expect(container.querySelector('[data-testid^="connection-row-harness-"]')).toBeNull();
  });

  it('shows the harness login even when a stored key currently outranks it', () => {
    // `resolved` names the openrouter key here. Reading it instead of searching
    // `sources` would hide the harness's own sign-in exactly when another funding
    // source happens to win.
    renderRows();
    expect(screen.getByTestId('connection-row-harness-claude')).toBeTruthy();
    expect(screen.getByTestId('connection-kind-harness-claude').textContent).toBe('CLI login');
  });

  it('says "Not checked" rather than guessing, when nobody has probed', () => {
    // The common case: `login_state` is not persisted, so every harness reads this
    // after a restart.
    renderRows();
    expect(screen.getByTestId('connection-status-harness-claude').textContent).toBe('Not checked');
  });

  it('says signed in only when a probe actually said so', () => {
    h.status = statusWith({ eligible: true, authority: 'cached', detail: 'signed in' });
    renderRows();
    expect(screen.getByTestId('connection-status-harness-claude').textContent).toBe('Signed in');
  });

  it('says signed out when the verdict is ineligible', () => {
    h.status = statusWith({ eligible: false, authority: 'cached', reason: 'claude is signed out' });
    renderRows();
    expect(screen.getByTestId('connection-status-harness-claude').textContent).toBe('Signed out');
  });

  it('carries the backend sentence verbatim, in the title', () => {
    // The backend owns this string; the cell shows a short word so the row stays on
    // one line, and the sentence rides along rather than being rewritten.
    h.status = statusWith({ detail: 'sign-in state not checked' });
    renderRows();
    expect(screen.getByTestId('connection-status-harness-claude').getAttribute('title')).toBe(
      'sign-in state not checked',
    );
  });

  it('opens the harness status screen for THAT harness', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('connection-harness-details-claude'));
    expect(h.openLlmSources).toHaveBeenCalledWith(h.navigation, 'claude');
  });
});
