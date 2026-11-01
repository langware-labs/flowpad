/**
 * Every error/warning carries what is known about it (`detail`), and Details opens one popup
 * that shows it — not a second toast. Repeats count up, a thrown backend error becomes its
 * request + answer, an alert that only kept the text is matched back to its failed call, and the
 * hub's limit sentence is read back into fields.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() }, Toaster: () => null }));

const { notify } = await import('@src/notifications/notify');
const { useAlertStore } = await import('@src/notifications/alerts-store');
const { recentFailedCalls, describeFailedCall } = await import('@sdk');
const { detailSections, detailText, limitFromText } = await import('@src/notifications/error-detail');
const { ErrorDetailsDialog } = await import('@src/notifications/ErrorDetailsDialog');
const { useErrorDetailsStore } = await import('@src/notifications/error-details-store');
const { useDiagnoseErrorStore } = await import('@src/notifications/diagnose/diagnose-error-store');

const latest = () => useAlertStore.getState().alerts[0];

const axios409 = () => ({
  isAxiosError: true,
  message: 'Request failed with status code 409',
  config: { method: 'post', url: '/api/v1/graph/data_source', headers: { 'X-Flow-Caller': '/dock/stream_inbox' } },
  response: {
    status: 409,
    data: {
      status: 'FAIL',
      message: "An data_source named 'GitHub PRs' already exists",
      data: { error_code: 'conflict' },
    },
    headers: {},
  },
});

describe('error details', () => {
  beforeEach(() => {
    useAlertStore.setState({ alerts: [] });
    recentFailedCalls.length = 0;
    useErrorDetailsStore.getState().close();
  });

  it('counts repeats of one alert and keeps when it first happened', () => {
    notify.error({ id: 'x', title: 'Boom' });
    const first = latest().firstAt;
    notify.error({ id: 'x', title: 'Boom' });
    notify.error({ id: 'x', title: 'Boom' });
    expect(latest().count).toBe(3);
    expect(latest().firstAt).toBe(first);
  });

  it('turns a thrown backend error into its request and answer', () => {
    notify.error({ title: 'Could not save', error: axios409() });
    const d = latest().detail!;
    expect(d.request).toEqual({ method: 'POST', url: '/api/v1/graph/data_source', caller: '/dock/stream_inbox' });
    expect(d.response?.status).toBe(409);
    expect(d.response?.errorCode).toBe('conflict');
    expect('error' in latest()).toBe(false);
  });

  it('matches an alert that kept only the text back to its failed call', () => {
    recentFailedCalls.unshift({
      at: Date.now(),
      message: 'Request failed with status code 409',
      detail: describeFailedCall(axios409())!,
    });
    notify.error({ title: 'Request failed with status code 409' });
    expect(latest().detail?.request?.url).toBe('/api/v1/graph/data_source');
  });

  it('never attaches an unrelated call', () => {
    recentFailedCalls.unshift({
      at: Date.now(),
      message: 'Request failed with status code 409',
      detail: describeFailedCall(axios409())!,
    });
    notify.error({ title: 'Something else broke' });
    expect(latest().detail).toBeUndefined();
  });

  it('reads the hub limit sentence back into fields', () => {
    expect(limitFromText("limit 'cost_usd_total' exceeded on endpoint me default (20158-3832-4c0d)")).toEqual({
      rule: 'cost_usd_total',
      endpoint: 'me default · 20158-3832-4c0d',
    });
  });

  it('shows only the sections that have something', () => {
    notify.warning({ title: 'Plain' });
    const titles = detailSections(latest()).map((s) => s.title);
    expect(titles).not.toContain('Request');
    expect(titles).toContain('When');
  });

  it('opens one popup, and Diagnose seeds the diagnosis with all of it', () => {
    notify.error({ title: 'Could not save', error: axios409() });
    render(<ErrorDetailsDialog />);
    act(() => useErrorDetailsStore.getState().open(latest()));
    expect(screen.getByTestId('error-details-dialog').textContent).toContain('/api/v1/graph/data_source');
    fireEvent.click(screen.getByText('Diagnose'));
    const seeded = useDiagnoseErrorStore.getState().detail ?? '';
    expect(seeded).toContain('already exists');
    expect(seeded).toContain('/api/v1/graph/data_source');
    expect(useErrorDetailsStore.getState().shown).toBeNull();
    expect(detailText(latest(), detailSections(latest()))).toContain('409');
  });
  it("reads FastAPI's list-shaped detail as the answer", () => {
    const d = describeFailedCall({
      isAxiosError: true,
      config: {},
      response: { status: 422, data: { detail: [{ msg: 'field required' }] } },
    });
    expect(d?.response.message).toBe('field required');
  });
});
