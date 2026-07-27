/**
 * The shipped setup-github journey: graph parses, acts are the capability-setup
 * kinds, and the confirm matchers validate capability rows as authored.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueryFilter } from '@sdk';
import { parseJourneyGraph } from '@src/journey/use-journey';

const GRAPH_PATH = path.resolve(
  __dirname,
  '../../../flow_sdk/system_projects/flowpad_assistant/.claude/journeys/setup-github/graph.json',
);

const graphText = readFileSync(GRAPH_PATH, 'utf-8');

describe('setup-github journey graph', () => {
  it('parses into the three guided steps with capability-setup acts', () => {
    const { steps } = parseJourneyGraph(graphText);
    expect(steps.map((s) => s.node_id)).toEqual(['s1-connect', 's2-install-gh', 's3-login-gh']);
    expect(steps.map((s) => s.act?.kind)).toEqual(['oauth_connect', 'setup_capability', 'device_login']);
    expect(steps[1].act?.capability).toBe('source_control.git.github.gh');
    expect(steps[2].act?.capability).toBe('source_control.git.github.gh');
    for (const step of steps) {
      expect(step.await?.tag).toBe('app.entity.updated');
      expect(step.await?.confirm?.type).toBe('capability');
    }
  });

  it('declares the capability gate', () => {
    const raw = JSON.parse(graphText) as { gate?: { requires_capabilities?: string[] } };
    expect(raw.gate?.requires_capabilities).toEqual(['source_control.git.github', 'source_control.git.github.gh']);
    expect((raw as { auto_launch?: boolean }).auto_launch).toBe(false);
  });

  it('s2 confirm means INSTALLED: a discovered value, regardless of auth state', () => {
    const { steps } = parseJourneyGraph(graphText);
    const filter = new QueryFilter({ match: steps[1].await!.confirm!.match! });
    const row = (value: unknown) => ({ kind: 'source_control.git.github.gh', value });
    expect(filter.validate(row({ path: '/usr/bin' }))).toBe(true);
    // explicitly checked-while-missing (state not_available, no value) must NOT pass
    expect(filter.validate(row(null))).toBe(false);
    expect(filter.validate(row(undefined))).toBe(false);
    expect(filter.validate({ kind: 'other', value: { path: '/x' } })).toBe(false);
  });

  it('s1/s3 confirms match only the available state of their kind', () => {
    const { steps } = parseJourneyGraph(graphText);
    const s1 = new QueryFilter({ match: steps[0].await!.confirm!.match! });
    expect(s1.validate({ kind: 'source_control.git.github', state: 'available' })).toBe(true);
    expect(s1.validate({ kind: 'source_control.git.github', state: 'none' })).toBe(false);
    const s3 = new QueryFilter({ match: steps[2].await!.confirm!.match! });
    expect(s3.validate({ kind: 'source_control.git.github.gh', state: 'available' })).toBe(true);
    expect(s3.validate({ kind: 'source_control.git.github.gh', state: 'not_available' })).toBe(false);
  });
});
