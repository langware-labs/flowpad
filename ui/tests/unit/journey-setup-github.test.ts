/**
 * The shipped setup-github journey: graph parses, acts are the capability-setup
 * kinds, and the confirm matchers validate capability rows as authored.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JourneyGraph, QueryFilter, type JourneyStep } from '@sdk';

/** The capability match a step's single `entity` condition carries. */
const entityMatch = (step: JourneyStep): Record<string, unknown> =>
  (step.waitFor[0] as { entity: { match: Record<string, unknown> } }).entity.match;

const GRAPH_PATH = path.resolve(
  __dirname,
  '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/journey/setup-github/graph.json',
);

const graphText = readFileSync(GRAPH_PATH, 'utf-8');

describe('setup-github journey graph', () => {
  it('parses into the three guided steps with capability-setup acts', () => {
    const { steps } = JourneyGraph.parse(graphText);
    expect(steps.map((s) => s.node_id)).toEqual(['s1-connect', 's2-install-gh', 's3-login-gh']);
    expect(steps.map((s) => s.act?.kind)).toEqual(['oauth_connect', 'setup_capability', 'device_login']);
    expect(steps[1].act?.capability).toBe('source_control.git.github.gh');
    expect(steps[2].act?.capability).toBe('source_control.git.github.gh');
    for (const step of steps) {
      // One condition: the capability row reaching its wanted state. No tag —
      // the runtime knows a capability change is what re-asks the store.
      expect(step.waitFor).toHaveLength(1);
      expect(step.waitFor[0]).toHaveProperty('entity.type', 'capability');
    }
  });

  it('declares the capability gate', () => {
    const raw = JSON.parse(graphText) as { gate?: { requires_capabilities?: string[] } };
    expect(raw.gate?.requires_capabilities).toEqual(['source_control.git.github', 'source_control.git.github.gh']);
    expect((raw as { auto_launch?: boolean }).auto_launch).toBe(false);
  });

  it('s2 confirm means INSTALLED: a discovered value, regardless of auth state', () => {
    const { steps } = JourneyGraph.parse(graphText);
    const filter = new QueryFilter({ match: entityMatch(steps[1]) });
    const row = (value: unknown) => ({ kind: 'source_control.git.github.gh', value });
    expect(filter.validate(row({ path: '/usr/bin' }))).toBe(true);
    // explicitly checked-while-missing (state not_available, no value) must NOT pass
    expect(filter.validate(row(null))).toBe(false);
    expect(filter.validate(row(undefined))).toBe(false);
    expect(filter.validate({ kind: 'other', value: { path: '/x' } })).toBe(false);
  });

  it('s1/s3 confirms match only the available state of their kind', () => {
    const { steps } = JourneyGraph.parse(graphText);
    const s1 = new QueryFilter({ match: entityMatch(steps[0]) });
    expect(s1.validate({ kind: 'source_control.git.github', state: 'available' })).toBe(true);
    expect(s1.validate({ kind: 'source_control.git.github', state: 'none' })).toBe(false);
    const s3 = new QueryFilter({ match: entityMatch(steps[2]) });
    expect(s3.validate({ kind: 'source_control.git.github.gh', state: 'available' })).toBe(true);
    expect(s3.validate({ kind: 'source_control.git.github.gh', state: 'not_available' })).toBe(false);
  });
});
