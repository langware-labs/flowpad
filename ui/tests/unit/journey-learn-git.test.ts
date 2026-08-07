/**
 * The learn-git journey: graph parses as authored, and the `git_check` act
 * runner verdicts follow REAL repo state (GitWorkdir mocked per predicate) and
 * announce done/failed on the bus with the act's `git_check:<target>` identity.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, GitWorkdir, TypeId } from '@sdk';
import { ACT_DONE_TAG, ACT_FAILED_TAG, runAct } from '@src/journey/act';

// dataContext.project/computeNodeTypeId are non-configurable MobX computeds —
// swap the whole singleton for a mutable stub (GitWorkdir stays the real class
// so its prototype probes can be spied per predicate).
const ctx = vi.hoisted(() => ({
  project: { fs_storage_mount_path: '/ws/proj' } as { fs_storage_mount_path: string } | null,
  workdir: null as string | null,
  computeNodeTypeId: null as { id: string } | null,
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get dataContext() {
    return ctx;
  },
}));
import { JourneyGraph } from '@sdk';
import type { JourneyActSpec } from '@sdk';

const GRAPH_PATH = path.resolve(
  __dirname,
  '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/journey/learn-git/graph.json',
);

const graphText = readFileSync(GRAPH_PATH, 'utf-8');

describe('learn-git journey graph', () => {
  it('parses into the authored steps, all git ops gated by git_check acts', () => {
    const { steps, start } = JourneyGraph.parse(graphText);
    expect(start?.kind).toBe('home');
    expect(steps.map((s) => s.node_id)).toEqual([
      'intro', 'terminal', 'init', 'stage', 'commit', 'branch', 'change',
    ]);
    const gitSteps = steps.slice(2);
    expect(gitSteps.map((s) => s.act?.expect)).toEqual(['repo', 'staged', 'clean', 'branch', 'dirty']);
    for (const step of gitSteps) {
      expect(step.act?.kind).toBe('git_check');
      expect(step.act?.dir).toBe('git-playground');
      // the await gates on THIS act's bus identity — unique per step
      expect(step.await?.tag).toBe('app.journey.act.done');
      expect(step.await?.target).toBe(`git_check:${step.act?.target}`);
    }
    expect(gitSteps.find((s) => s.act?.expect === 'branch')?.act?.branch).toBe('practice');
  });

  it('is deep-link-only and the intro/terminal steps use the standard gates', () => {
    const raw = JSON.parse(graphText) as { auto_launch?: boolean };
    expect(raw.auto_launch).toBe(false);
    const { steps } = JourneyGraph.parse(graphText);
    expect(steps[0].await).toEqual({ tag: 'app.page.signal', target: 'next' });
    // the shell ROUTE, not agentic_process creation: a plain Terminal mints a
    // shell (no process), and every opener ends on a `dock:shell/…` navigation
    expect(steps[1].await).toEqual({ tag: 'app.route.loaded', target: 'dock:shell/*' });
  });
});

describe('git_check act runner', () => {
  const act = (over: Partial<JourneyActSpec>): JourneyActSpec => ({
    kind: 'git_check', target: 'T', dir: 'git-playground', ...over,
  });

  let outcomes: Array<{ tag: string; target: string }>;
  let unsubs: Array<() => void>;

  beforeEach(() => {
    outcomes = [];
    const record = (tag: string) => (e: { target: string }) =>
      outcomes.push({ tag, target: e.target });
    unsubs = [
      EventBus.on(ACT_DONE_TAG, record(ACT_DONE_TAG)),
      EventBus.on(ACT_FAILED_TAG, record(ACT_FAILED_TAG)),
    ];
    ctx.project = { fs_storage_mount_path: '/ws/proj' };
    ctx.workdir = null;
    ctx.computeNodeTypeId = new TypeId('compute_node', 'node-1');
  });

  afterEach(() => {
    unsubs.forEach((u) => u());
    vi.restoreAllMocks();
  });

  const status = (files: Array<{ staged: boolean }>, error: string | null = null) =>
    ({ error, branch: 'main', ahead: 0, behind: 0, files }) as never;

  it('repo: done iff the workdir is a git repository, probed under the project dir', async () => {
    const isInit = vi.spyOn(GitWorkdir.prototype, 'isInit').mockResolvedValue(true);
    expect(await runAct(act({ expect: 'repo' }))).toBe(true);
    expect(outcomes).toEqual([{ tag: ACT_DONE_TAG, target: 'git_check:T' }]);
    const git = isInit.mock.instances[0] as unknown as GitWorkdir;
    expect(git.workDir).toBe('/ws/proj/git-playground');
    expect(git.computeNodeId).toBe('node-1');

    isInit.mockResolvedValue(false);
    expect(await runAct(act({ expect: 'repo' }))).toBe(false);
    expect(outcomes[1]).toEqual({ tag: ACT_FAILED_TAG, target: 'git_check:T' });
  });

  it('staged / dirty / clean read the real status', async () => {
    const getStatus = vi.spyOn(GitWorkdir.prototype, 'getStatus');
    const hasCommit = vi.spyOn(GitWorkdir.prototype, 'hasCommit').mockResolvedValue(true);

    getStatus.mockResolvedValue(status([{ staged: true }]));
    expect(await runAct(act({ expect: 'staged' }))).toBe(true);
    getStatus.mockResolvedValue(status([{ staged: false }]));
    expect(await runAct(act({ expect: 'staged' }))).toBe(false);

    expect(await runAct(act({ expect: 'dirty' }))).toBe(true);
    getStatus.mockResolvedValue(status([]));
    expect(await runAct(act({ expect: 'dirty' }))).toBe(false);

    expect(await runAct(act({ expect: 'clean' }))).toBe(true);
    hasCommit.mockResolvedValue(false); // empty tree but NO commit yet ≠ clean
    expect(await runAct(act({ expect: 'clean' }))).toBe(false);

    getStatus.mockResolvedValue(status([], 'not a git repository'));
    expect(await runAct(act({ expect: 'staged' }))).toBe(false);
  });

  it('branch: done only when the CURRENT branch matches', async () => {
    const getBranch = vi.spyOn(GitWorkdir.prototype, 'getBranch').mockResolvedValue('practice');
    expect(await runAct(act({ expect: 'branch', branch: 'practice' }))).toBe(true);
    getBranch.mockResolvedValue('main');
    expect(await runAct(act({ expect: 'branch', branch: 'practice' }))).toBe(false);
    expect(await runAct(act({ expect: 'branch' }))).toBe(false); // no branch named → never done
  });

  it('fails safe: no project workdir, unknown expect, or a thrown probe', async () => {
    vi.spyOn(GitWorkdir.prototype, 'isInit').mockRejectedValue(new Error('boom'));
    expect(await runAct(act({ expect: 'repo' }))).toBe(false);
    expect(await runAct(act({ expect: undefined }))).toBe(false);
    ctx.project = null;
    ctx.workdir = null;
    expect(await runAct(act({ expect: 'repo' }))).toBe(false);
    expect(outcomes.every((o) => o.tag === ACT_FAILED_TAG)).toBe(true);
  });
});
