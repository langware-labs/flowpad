/**
 * `decideNavigation`: the backend's `navigation.outcome` → a DockPointer to navigate, or the prompt.
 * The backend's own address wins; a file / URL target with no address is built here; anything
 * else is the prompt, unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

const navigationDecision = vi.hoisted(() => vi.fn());
vi.mock('@sdk/decision', () => ({ navigationDecision }));

import { decideNavigation } from '@src/navigation/navigation-decision';
import { ViewType } from '@src/types/ViewType';

describe('decideNavigation', () => {
  it('navigates to the address the backend answered, query included', async () => {
    navigationDecision.mockResolvedValueOnce({
      decision: { route: 'quick', target: { kind: 'view', value: 'search?q=widget' } },
      candidates: [],
      address: '/dock/search?q=widget',
    });
    const { dock, prompt } = await decideNavigation('search for widget');
    expect(prompt).toBeUndefined();
    expect(dock?.viewType).toBe(ViewType.SEARCH);
    expect(dock?.options?.q).toBe('widget');
  });

  it('builds the dock itself for a URL target the backend leaves to it', async () => {
    navigationDecision.mockResolvedValueOnce({
      decision: { route: 'quick', target: { kind: 'url', value: 'https://linear.app' } },
      candidates: [],
    });
    expect((await decideNavigation('open https://linear.app')).dock?.viewType).toBe(ViewType.WEB_APP);
  });

  it('asks the prompt when nothing is opened', async () => {
    navigationDecision.mockResolvedValueOnce({
      decision: { route: 'agentic' },
      candidates: [],
      prompt: 'summarize the README',
    });
    expect(await decideNavigation('summarize the README')).toEqual({ prompt: 'summarize the README' });
  });
});
