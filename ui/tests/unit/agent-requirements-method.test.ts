import { describe, expect, it } from 'vitest';
import { Agent } from '@sdk';

describe('Agent requirements', () => {
  it('a record that declares requirements keeps them as data', () => {
    const declared = [{ kind: 'variable', name: 'TEAM' }];
    const agent = new Agent({
      id: '6765397d-22f5-4449-9b07-6a8da8b7badb',
      name: 'support',
      requirements: declared,
    } as never);

    expect(agent.requirements).toEqual(declared);
    // What a deployment needs is asked of its project: `Project.requirements(mainAgentId)`.
  });
});
