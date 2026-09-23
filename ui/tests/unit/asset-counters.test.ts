/**
 * Home asset counters: the number on a box is the length of the list its table
 * shows. Running = one of the project's agents with an agent deployment; the
 * table behind a box is addressed by its URL alone.
 */
import type { Agent, Deployment } from '@sdk';
import { KIND_AGENT } from '@sdk';
import { agentSource, deploymentsByAgent, runningRows, toAgentRows } from '@src/components/asset-counters/agent-counters';
import { matchesQuickSearch, quickSearchTerms } from '@src/components/asset-counters/quick-search';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { describe, expect, it } from 'vitest';

const agent = (id: string, name: string, bundleDirectory: string | null = null) =>
  ({ id, displayName: name, bundleDirectory, typeId: { toString: () => `agent:${id}` } }) as unknown as Agent;
const deployment = (id: string, parent: string | null, kind = KIND_AGENT) =>
  ({ id, kind, agentTypeId: parent?.startsWith('agent:') ? { toString: () => parent } : null }) as unknown as Deployment;

describe('agent counters', () => {
  const zed = agent('z', 'Zed');
  const amy = agent('a', 'Amy');
  const deployments = [
    deployment('d1', 'agent:z'),
    deployment('d2', 'agent:z'),
    deployment('d3', 'agent:elsewhere'),
    deployment('web', 'project:p', 'runtime.web'),
    deployment('orphan', null),
  ];

  it('groups deployments by the agent they place', () => {
    const byAgent = deploymentsByAgent(deployments);
    expect(byAgent.get('agent:z')?.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(byAgent.has('agent:a')).toBe(false);
  });

  it('running is the distinct project agents that have a deployment', () => {
    const rows = toAgentRows([zed, amy], deploymentsByAgent(deployments));
    expect(rows.map((r) => r.agent.displayName)).toEqual(['Amy', 'Zed']);
    expect(runningRows(rows).map((r) => r.agent.id)).toEqual(['z']);
  });

  it('source is the folder above agentic-assets', () => {
    expect(agentSource(agent('x', 'X', '/Users/me/proj/agentic-assets/agent/x'))).toBe('proj');
    expect(agentSource(agent('y', 'Y', '/Users/me/other/y'))).toBe('other');
    expect(agentSource(agent('n', 'N'))).toBe('');
  });
});

describe('asset list pointer', () => {
  it('round-trips group and counter through the URL', () => {
    const url = DockPointer.forAssetList('agents', 'running').toUrl();
    expect(url).toContain('/dock/asset-list');
    const back = DockPointer.fromUrl(url);
    expect(back.viewType).toBe(ViewType.ASSET_LIST);
    expect(back.options).toMatchObject({ group: 'agents', counter: 'running' });
  });
});

describe('quick search', () => {
  it('matches every term, case-insensitively, in any order', () => {
    const haystack = 'dana sales agent local';
    expect(matchesQuickSearch(haystack, quickSearchTerms('Local DANA'))).toBe(true);
    expect(matchesQuickSearch(haystack, quickSearchTerms('dana e2b'))).toBe(false);
    expect(matchesQuickSearch(haystack, quickSearchTerms('   '))).toBe(true);
  });
});
