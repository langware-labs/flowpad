/**
 * Home asset counters: the number on a box is the length of the list its table
 * shows. Running = one of the project's agents with an agent deployment; the
 * table behind a box is addressed by its URL alone.
 */
import type { Agent, ComputeNode, Deployment } from '@sdk';
import { ExecutionEnvironmentStatus } from '@sdk';
import { isActiveMachine } from '@src/components/asset-counters/hub-counters';
import { isLiveDeployment, isPaused, isRunning } from '@src/components/asset-counters/placement';
import { agentSource, deploymentsByAgent, toAgentRows } from '@src/components/asset-counters/agent-counters';
import { counterAt, crossCounters, selectionOf } from '@src/components/asset-counters/axes';
import { skillsUnder } from '@src/components/asset-counters/skill-counters';
import type { Skill } from '@sdk';
import { matchesQuickSearch, quickSearchTerms } from '@src/components/asset-counters/quick-search';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { describe, expect, it } from 'vitest';

const agent = (id: string, name: string, bundleDirectory: string | null = null) =>
  ({ id, displayName: name, bundleDirectory, typeId: { toString: () => `agent:${id}` } }) as unknown as Agent;
const deployment = (id: string, parent: string | null, state: string | null = null) =>
  ({
    id,
    agentTypeId: parent?.startsWith('agent:') ? { toString: () => parent } : null,
    status: { provider_state: state },
  }) as unknown as Deployment;

describe('agent counters', () => {
  const zed = agent('z', 'Zed');
  const amy = agent('a', 'Amy');
  const deployments = [
    deployment('d1', 'agent:z'),
    deployment('d2', 'agent:z'),
    deployment('d3', 'agent:elsewhere'),
    deployment('web', 'project:p'),
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
    expect(rows.filter(isRunning).map((r) => r.agent.id)).toEqual(['z']);
  });

  it("Flowpad's own (system-scope) agents are neither counted nor listed", () => {
    const vibe = { ...agent('v', 'Vibe'), scope: 'system' } as unknown as Agent;
    const mine = { ...agent('m', 'Mine'), scope: 'user' } as unknown as Agent;
    const rows = toAgentRows([vibe, mine, amy], new Map());
    expect(rows.map((r) => r.agent.id)).toEqual(['a', 'm']);
  });

  it('source is the folder above agentic-assets', () => {
    expect(agentSource(agent('x', 'X', '/Users/me/proj/agentic-assets/agent/x'))).toBe('proj');
    expect(agentSource(agent('y', 'Y', '/Users/me/other/y'))).toBe('other');
    expect(agentSource(agent('n', 'N'))).toBe('');
  });
});

describe('scope × status counters', () => {
  const live = { deployments: [deployment('l', 'agent:x')] };
  const paused = { deployments: [deployment('p', 'agent:y', 'paused')] };
  const idle = { deployments: [] };

  it('running = a live placement, paused = placed but every placement paused', () => {
    expect([live, paused, idle].map(isRunning)).toEqual([true, false, false]);
    expect([live, paused, idle].map(isPaused)).toEqual([false, true, false]);
  });

  it('crosses every scope with every status under a <scope>.<status> key', () => {
    const counters = crossCounters({
      label: 'Apps',
      scopes: [
        { key: 'project', label: 'p', items: [live], isLoading: false },
        { key: 'all', label: 'All', items: [live, paused, idle], isLoading: false },
      ],
      statuses: [
        { key: 'running', label: 'Running', keep: isRunning },
        { key: 'paused', label: 'Paused', keep: isPaused },
        { key: 'all', label: 'All' },
      ],
    });
    expect(counters.map((c) => `${c.key}=${c.items.length}`)).toEqual([
      'project.running=1',
      'project.paused=0',
      'project.all=1',
      'all.running=1',
      'all.paused=1',
      'all.all=3',
    ]);
    // An unknown key falls back to this project, everything.
    expect(selectionOf(counters, 'nope')).toEqual({ scope: 'project', status: 'all' });
    expect(counterAt(counters, selectionOf(counters, 'all.paused'))?.items).toEqual([paused]);
  });

  it('a group with no axes is one counter keyed "all"', () => {
    expect(crossCounters({ label: 'Skills', items: [1, 2] }).map((c) => c.key)).toEqual(['all']);
  });

  it("project skills are the ones under the project's roots, either slash", () => {
    const skill = (ref: string) => ({ asset_ref: ref }) as Skill;
    const skills = [
      skill('/w/proj/.claude/skills/a'),
      skill('C:\\w\\proj\\.claude\\skills\\b'),
      skill('/w/projx/.claude/skills/c'),
    ];
    expect(skillsUnder(skills, ['/w/proj'])).toEqual([skills[0]]);
    expect(skillsUnder(skills, ['C:/w/proj'])).toEqual([skills[1]]);
  });
});

describe('asset list pointer', () => {
  it('round-trips group and counter through the URL', () => {
    const url = DockPointer.forCounterAssets('agents', 'running').toUrl();
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

describe('hub counters — active rules', () => {
  const dep = (state: string | null) => ({ status: { provider_state: state } }) as unknown as Deployment;

  it('a deployment is live unless paused', () => {
    expect(isLiveDeployment(dep('running'))).toBe(true);
    expect(isLiveDeployment(dep(null))).toBe(true);
    expect(isLiveDeployment(dep('paused'))).toBe(false);
  });

  it('an agent is active only with a live deployment', () => {
    const a = {} as Agent;
    expect(isRunning({ agent: a, deployments: [] })).toBe(false);
    expect(isRunning({ agent: a, deployments: [dep('paused')] })).toBe(false);
    expect(isRunning({ agent: a, deployments: [dep('paused'), dep('running')] })).toBe(true);
  });

  it('a machine is active only when READY', () => {
    const node = {} as ComputeNode;
    expect(isActiveMachine({ node, status: ExecutionEnvironmentStatus.READY })).toBe(true);
    expect(isActiveMachine({ node, status: ExecutionEnvironmentStatus.PAUSED })).toBe(false);
    expect(isActiveMachine({ node, status: null })).toBe(false);
  });
});
