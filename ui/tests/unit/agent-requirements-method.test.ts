import { describe, expect, it } from 'vitest';
import { Agent } from '@sdk';

describe('Agent requirements', () => {
  it('a record that declares requirements keeps them as data and keeps the method that asks the backend', () => {
    const declared = [{ kind: 'variable', name: 'TEAM' }];
    const agent = new Agent({
      id: '6765397d-22f5-4449-9b07-6a8da8b7badb',
      name: 'support',
      requirements: declared,
    } as never);

    expect(agent.requirements).toEqual(declared);
    expect(typeof agent.fetchRequirements).toBe('function');
  });
});
