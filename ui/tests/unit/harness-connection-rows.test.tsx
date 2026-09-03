/**
 * Harness device logins in the Connections table.
 *
 * The row is a pure presenter: it reads the funding picture and reports it, and
 * the host owns navigation. So this file needs no router.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ status: null as unknown }));

// The hook, not the service: `use-llm-sources` also exports `harnessKinds`,
// `workerOf` and `sourcesOfKind`, so the mock must spread the original or the
// component loses them.
vi.mock('@src/components/llm-sources/use-llm-sources', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmSources: () => ({ status: h.status, isLoading: false }),
}));

const { HarnessConnectionRows } = await import(
  '@src/components/connections-manager/harness-connection-rows'
);

const DEVICE = 'llm_endpoint-device-claude';
const KEY = 'llm_endpoint-key-openrouter';

/**
 * One harness funded two ways. The stored key is here because it is the scenario
 * the row has to survive — not because the component reads `resolved`; it does not.
 */
function statusWith(device: Record<string, unknown>) {
  return {
    sources: {
      'harness.claude.cli': [
        { endpoint_typeid: DEVICE, eligible: true, authority: 'presumed', ...device },
        { endpoint_typeid: KEY, eligible: true, authority: 'proven' },
      ],
    },
    resolved: { 'harness.claude.cli': { endpoint_typeid: KEY } },
    endpoints: { [DEVICE]: { kind: 'device' }, [KEY]: { kind: 'api_key' } },
  };
}

const renderRows = (onDetails?: (worker: string) => void) =>
  render(
    <table>
      <tbody>
        <HarnessConnectionRows onDetails={onDetails} />
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
    h.status = null;
    const { container } = renderRows();
    expect(container.querySelector('[data-testid^="connection-row-harness-"]')).toBeNull();
  });

  it('shows the harness login even when a stored key currently outranks it', () => {
    renderRows();
    expect(screen.getByTestId('connection-row-harness-claude')).toBeTruthy();
    expect(screen.getByTestId('connection-kind-harness-claude').textContent).toBe('CLI login');
  });

  it.each([
    [{}, 'Not checked'],
    [{ eligible: true, authority: 'cached' }, 'Signed in'],
    [{ eligible: true, authority: 'proven' }, 'Signed in'],
    [{ eligible: false, authority: 'cached' }, 'Signed out'],
  ])('reports the backend verdict %o as %s', (device, word) => {
    // `proven` is in the table on purpose: an earlier hand-written ladder let it
    // fall through to "Not checked", reading the strongest verdict the backend can
    // issue as "nobody has asked".
    h.status = statusWith(device);
    renderRows();
    expect(screen.getByTestId('connection-status-harness-claude').textContent).toBe(word);
  });

  it('carries the backend sentence verbatim, in the title', () => {
    h.status = statusWith({ detail: 'sign-in state not checked' });
    renderRows();
    expect(screen.getByTestId('connection-status-harness-claude').getAttribute('title')).toBe(
      'sign-in state not checked',
    );
  });

  it('asks the host to open the harness status screen for THAT harness', async () => {
    const onDetails = vi.fn();
    renderRows(onDetails);
    await userEvent.click(screen.getByTestId('connection-harness-details-claude'));
    expect(onDetails).toHaveBeenCalledWith('claude');
  });
});
