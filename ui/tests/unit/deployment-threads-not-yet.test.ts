import { describe, expect, it } from 'vitest';

import { isStartingMachine } from '@src/components/assets/editor/agent-profile/deployment/use-deployment-threads';

describe('a machine that is still starting', () => {
  it('has no agent identity yet: that is not a failure', () => {
    expect(isStartingMachine(410, 'agent identity is unavailable')).toBe(true);
    expect(isStartingMachine(410, "the agent's identity is unavailable")).toBe(true);
  });

  it('is not any other 410 or any other status', () => {
    expect(isStartingMachine(410, 'agent process route no longer matches its machine')).toBe(false);
    expect(isStartingMachine(500, 'agent identity is unavailable')).toBe(false);
    expect(isStartingMachine(undefined, 'agent identity is unavailable')).toBe(false);
  });
});
