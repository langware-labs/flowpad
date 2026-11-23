/**
 * The Upgrade screen: opened by `agent.no_token_source` for a spent budget (and only for that),
 * drawn from the funding record, and closed by itself once the budget has money again. The chat's
 * own card for a refused turn is the other way in, which is what a reload leaves.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, FlowData, FlowElementTypes } from '@sdk';

const EP = 'llm_endpoint-11111111-2222-4333-8444-555555555555';
const spent = { endpoint_typeid: EP, name: 'dana default', reason_code: 'budget_used' };
const h = vi.hoisted(() => ({ status: null as unknown, invalidate: vi.fn() }));
vi.mock('@src/components/llm-sources/use-llm-sources', () => ({
  useLlmSources: () => ({ status: h.status, isLoading: false }),
  invalidateLlmFunding: h.invalidate,
}));
vi.mock('@src/components/llm-sources/use-hub-remaining', () => ({
  invalidateHubRemaining: vi.fn(),
  useHubRemaining: () => ({ [EP]: { key: 'cost_usd_total', remaining: { limit: 0.05, used: 0.052, remaining: 0 } } }),
}));
vi.mock('@src/components/workers/WorkerTypeSelect', () => ({ WorkerTypeSelect: () => null }));

import { WorkerUnavailableNotice } from '@src/components/entity-execution-panel/WorkerUnavailableNotice';
import { NO_TOKEN_SOURCE_TAG, UPGRADE_URL, UpgradeScreenRoot } from '@src/components/upgrade/UpgradeScreen';
import { useUpgradeStore } from '@src/components/upgrade/upgrade-store';

const root = () => (
  <QueryClientProvider client={new QueryClient()}>
    <UpgradeScreenRoot />
  </QueryClientProvider>
);
const announce = (code: string) =>
  act(
    () =>
      void EventBus.emit(NO_TOKEN_SOURCE_TAG, 'agentic_process:p1', {
        worker_type: 'claude',
        code,
        endpoint_typeid: EP,
      }),
  );

describe('UpgradeScreen', () => {
  beforeEach(() => {
    EventBus.clear();
    h.invalidate.mockReset();
    h.status = { sources: { 'harness.claude.cli': [spent] } };
  });
  afterEach(() => {
    cleanup();
    useUpgradeStore.getState().setOpen(false);
  });

  it('opens on a spent budget only, shows what it held, and closes once it has money again', () => {
    const { rerender } = render(root());
    announce('signed_out');
    expect(screen.queryByTestId('upgrade-screen')).toBeNull();
    expect(h.invalidate).toHaveBeenCalledTimes(1); // any refusal re-reads the funding record

    announce('budget_used');
    expect(screen.getByTestId('upgrade-budget').textContent).toBe('dana default$0.050 of $0.050 used');
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(screen.getByTestId('upgrade-cta'));
    expect(opened).toHaveBeenCalledWith(UPGRADE_URL, '_blank', 'noopener,noreferrer');

    h.status = { sources: { 'harness.claude.cli': [{ ...spent, reason_code: '' }] } };
    rerender(root());
    expect(screen.queryByTestId('upgrade-screen')).toBeNull();
  });

  it("the chat's card for a spent budget says so in its own words and opens the screen", () => {
    const vendor = "API Error: Request rejected (429) · limit 'cost_usd_total' exceeded on endpoint dana default";
    const refused = new FlowData(FlowElementTypes.WORKER_UNAVAILABLE, JSON.stringify({ message: vendor }), {
      'data-type': 'object',
      reason: 'budget_used',
    });
    render(<WorkerUnavailableNotice flowData={refused} worker="claude_code" />);
    const notice = screen.getByTestId('worker-unavailable-notice');
    expect(notice.textContent).toContain("You're out of tokens");
    expect(notice.textContent).not.toContain('API Error');
    fireEvent.click(screen.getByTestId('worker-unavailable-upgrade'));
    expect(useUpgradeStore.getState().open).toBe(true);
  });
});
