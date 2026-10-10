/**
 * `launch-plan.ts` — the boundary between a launch's USE stage (the hub page) and its SETUP
 * stage (the machine's `action=launch` handler). Both legs land on the path this writes, so
 * what one end writes the other must read back exactly — and a malformed path reads as none.
 */
import { describe, expect, it } from 'vitest';
import { type LaunchPlan, launchPlanFromParams, launchPlanToPath } from '@src/pages/entry/launch-plan';

const roundTrip = (plan: LaunchPlan) => {
  const path = launchPlanToPath(plan);
  return { path, back: launchPlanFromParams(new URL(path, 'http://x').searchParams) };
};

describe('launch plan', () => {
  it('lands on the home route with action=launch', () => {
    expect(launchPlanToPath({ target: { projectId: 'p1' } })).toBe('/?action=launch&target=p1');
  });

  it.each<[string, LaunchPlan]>([
    ['a project alone', { target: { projectId: 'p1' } }],
    ['a project with its face', { target: { projectId: 'p1' }, agentId: 'a1' }],
    ['a controller on a target', { target: { projectId: 'p1' }, controllerId: 'c1', agentId: 'a1' }],
    ['a repository target', { target: { repo: 'https://github.com/acme/site', branch: 'dev' }, controllerId: 'c1' }],
  ])('round-trips %s', (_label, plan) => {
    expect(roundTrip(plan).back).toEqual(plan);
  });

  it('reads no plan from another action, no target, or two targets', () => {
    const read = (q: string) => launchPlanFromParams(new URLSearchParams(q));
    expect(read('action=open&target=p1')).toBeNull();
    expect(read('action=launch&controller=c1')).toBeNull();
    expect(read('action=launch&target=p1&target_repo=https://github.com/acme/site')).toBeNull();
  });
});
