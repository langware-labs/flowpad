/** `FundingHops` draws a full level with its numbers and a narrowed one with its kind and team only. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FundingHops, chainLine } from '@src/components/token-plan/FundingChain';
import { fundingPath } from '@src/components/token-plan/source-tree';

const day = { limit: 50, used: 0.29, remaining: 49.71, window: 'day', resets_at: 1793318400 };
const chain = (team: Record<string, unknown>, extra: unknown[] = [], ids = ['me', 'team']) =>
  ({
    entry: { id: 'me', name: 'Eran' },
    hops: [
      { id: 'me', name: 'Eran', source_kind: 'user', is_root: false, remaining: { cost_usd_per_day: day }, limits: {} },
      { id: 'team', ...team },
      ...extra,
    ],
    paths: [ids],
    missing_sources: [],
    sticky_root_for_me: null,
  }) as never;

afterEach(() => cleanup());

describe('FundingHops', () => {
  it('a narrowed parent shows its team, says its budget is not shared, and shows no numbers', () => {
    const path = fundingPath(chain({ source_kind: 'team', scope_name: 'Dev Team', is_root: false }));
    render(<FundingHops path={path} entryLabel="Eran Shlomo" />);
    expect(screen.getByTestId('funding-hop-me').textContent).toContain('$49.71');
    expect(screen.getByTestId('funding-hop-me').textContent).toContain('per day · resets 00:00 UTC');
    const team = screen.getByTestId('funding-hop-team');
    expect(team.textContent).toContain('Dev Team');
    expect(screen.getByTestId('funding-hop-redacted')).toBeTruthy();
    expect(team.textContent).not.toContain('$');
    expect(chainLine(path)).toBe('Dev Team');
  });

  it('a readable chain shows every level and the root provider', () => {
    const total = { limit: 1000, used: 0.38, remaining: 999.62, window: 'total', resets_at: null };
    const path = fundingPath(
      chain(
        {
          name: 'Dev Team budget',
          source_kind: 'team',
          scope_name: 'Dev Team',
          is_root: false,
          remaining: { cost_usd_total: total },
          limits: {},
        },
        [
          {
            id: 'org',
            name: 'Langware budget',
            source_kind: 'organization',
            scope_name: 'Langware',
            is_root: true,
            provider: 'vertex',
            remaining: { cost_usd_total: total },
            limits: {},
          },
        ],
        ['me', 'team', 'org'],
      ),
    );
    render(<FundingHops path={path} />);
    expect(screen.getByTestId('funding-hop-org').textContent).toContain('pays with a Vertex key');
    expect(screen.getByTestId('funding-hop-team').textContent).toContain('lifetime · never resets');
    expect(screen.queryByTestId('funding-hop-redacted')).toBeNull();
    expect(chainLine(path)).toBe('Dev Team budget › Langware budget · Vertex');
  });
});
