/**
 * `proc.artifacts` is a PROPERTY kept live, not a fetch.
 *
 * The one-shot REST GET (`loadArtifacts`) hydrates it once; after that the
 * `artifact.created|updated|deleted` bus lane applies deltas BY ID. The two
 * halves race, and the losing order is the dangerous one: fetch-then-subscribe
 * silently drops any event landing in the gap, leaving the array permanently
 * short a row with no error anywhere. So the contract is subscribe-first, and
 * the snapshot MERGES into whatever the deltas already did rather than
 * replacing it — a stale snapshot may never clobber an applied event, and may
 * never resurrect a deleted row.
 *
 * The delete assertions are deliberately the ones that catch real bugs: remove
 * the MIDDLE of three (an index splice passes a 2-element test and corrupts a
 * 3-element one), survivors keep their fields and order, unknown ids are inert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, Artifact, ProcessStatus, dataManager } from '@sdk';
import type { FlowEvent } from '@sdk/tags/EventBus';

/** Factory so the spy's exact MockInstance type is inferred, not restated. */
const spyCallAction = () => vi.spyOn(dataManager, 'callAction');

const PROC_ID = 'e5a2c1b0-0000-4000-8000-0000000000aa';
const PROC_TYPEID = `agentic_process-${PROC_ID}`;
const OTHER_TYPEID = 'agentic_process-11111111-0000-4000-8000-000000000011';

const ID_A = '9c4d0e11-0000-4000-8000-0000000000a1';
const ID_B = '9c4d0e11-0000-4000-8000-0000000000b2';
const ID_C = '9c4d0e11-0000-4000-8000-0000000000c3';

const row = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'artifact',
  name,
  kind: 'content.file',
  asset_ref: `/repo/${name}`,
  generated_by: PROC_TYPEID,
  created_date: '2026-08-01T10:00:00Z',
  ...overrides,
});

/** The lean bus envelope the backend's `artifact_on_tag` adapter emits. */
const event = (
  tag: 'artifact.created' | 'artifact.updated' | 'artifact.deleted',
  id: string,
  data: Record<string, unknown> = {},
): FlowEvent => ({
  id: 'evt-1',
  timestamp: '2026-08-01T11:00:00Z',
  tag,
  target: `artifact:${id}`,
  data: {
    artifact_id: id,
    generated_by: PROC_TYPEID,
    kind: 'content.file',
    ...data,
  },
  ctx: { origin: 'local_server', scope: [`agentic_process:${PROC_ID}`] },
});

const proc = () => new AgenticProcess({ id: PROC_ID, status: ProcessStatus.RUNNING });
const names = (p: AgenticProcess) => p.artifacts.map((a) => a.name);

describe('AgenticProcess.artifacts — the property', () => {
  let callActionSpy: ReturnType<typeof spyCallAction>;

  beforeEach(() => {
    callActionSpy = spyCallAction();
  });
  afterEach(() => {
    callActionSpy.mockRestore();
  });

  it('is an empty array before anything loads — never undefined', () => {
    expect(proc().artifacts).toEqual([]);
  });

  it('hydrates from the one-shot GET and does not re-fetch', async () => {
    callActionSpy.mockResolvedValue({ artifacts: [row(ID_A, 'report.md')] } as never);
    const p = proc();

    await p.loadArtifacts();
    await p.loadArtifacts();

    expect(callActionSpy).toHaveBeenCalledOnce();
    expect(p.artifacts).toHaveLength(1);
    expect(p.artifacts[0]).toBeInstanceOf(Artifact);
    expect(p.artifacts[0].asset_ref).toBe('/repo/report.md');
  });

  it('shares one in-flight request across concurrent callers', async () => {
    callActionSpy.mockResolvedValue({ artifacts: [row(ID_A, 'report.md')] } as never);
    const p = proc();

    await Promise.all([p.loadArtifacts(), p.loadArtifacts()]);

    expect(callActionSpy).toHaveBeenCalledOnce();
    expect(p.artifacts).toHaveLength(1);
  });

  it('replaces the array on every change, so a memoized reader re-renders', async () => {
    callActionSpy.mockResolvedValue({ artifacts: [] } as never);
    const p = proc();
    await p.loadArtifacts();
    const before = p.artifacts;

    p.applyArtifactEvent(event('artifact.created', ID_A, { name: 'report.md' }));

    expect(p.artifacts).not.toBe(before);
  });
});

describe('AgenticProcess.artifacts — bus deltas', () => {
  let callActionSpy: ReturnType<typeof spyCallAction>;

  beforeEach(() => {
    callActionSpy = spyCallAction();
    callActionSpy.mockResolvedValue({ artifacts: [] } as never);
  });
  afterEach(() => {
    callActionSpy.mockRestore();
  });

  const withThree = async () => {
    const p = proc();
    callActionSpy.mockResolvedValue({
      artifacts: [row(ID_A, 'a.md'), row(ID_B, 'b.md'), row(ID_C, 'c.md')],
    } as never);
    await p.loadArtifacts();
    return p;
  };

  it('appends a created artifact', async () => {
    const p = proc();
    await p.loadArtifacts();

    p.applyArtifactEvent(event('artifact.created', ID_A, { name: 'report.md', asset_ref: '/r/report.md' }));

    expect(names(p)).toEqual(['report.md']);
    expect(p.artifacts[0]).toBeInstanceOf(Artifact);
    expect(p.artifacts[0].asset_ref).toBe('/r/report.md');
  });

  it('is idempotent — a duplicate create does not double the row', async () => {
    const p = proc();
    await p.loadArtifacts();

    p.applyArtifactEvent(event('artifact.created', ID_A, { name: 'report.md' }));
    p.applyArtifactEvent(event('artifact.created', ID_A, { name: 'report.md' }));

    expect(p.artifacts).toHaveLength(1);
  });

  it('updates in place, keeping position', async () => {
    const p = await withThree();

    p.applyArtifactEvent(event('artifact.updated', ID_B, { name: 'renamed.md' }));

    expect(names(p)).toEqual(['a.md', 'renamed.md', 'c.md']);
  });

  it('deletes the MIDDLE of three by id, leaving survivors intact and ordered', async () => {
    const p = await withThree();

    p.applyArtifactEvent(event('artifact.deleted', ID_B));

    expect(p.artifacts).toHaveLength(2);
    expect(names(p)).toEqual(['a.md', 'c.md']);
    expect(p.artifacts.map((a) => a.id)).toEqual([ID_A, ID_C]);
    expect(p.artifacts[1].asset_ref).toBe('/repo/c.md');
  });

  it('is inert for an unknown id, and for a repeated delete', async () => {
    const p = await withThree();

    p.applyArtifactEvent(event('artifact.deleted', 'ffffffff-0000-4000-8000-00000000ffff'));
    expect(p.artifacts).toHaveLength(3);

    p.applyArtifactEvent(event('artifact.deleted', ID_B));
    p.applyArtifactEvent(event('artifact.deleted', ID_B));
    expect(p.artifacts).toHaveLength(2);
  });

  it('empties to [] on the last delete', async () => {
    const p = proc();
    await p.loadArtifacts();
    p.applyArtifactEvent(event('artifact.created', ID_A, { name: 'only.md' }));

    p.applyArtifactEvent(event('artifact.deleted', ID_A));

    expect(p.artifacts).toEqual([]);
  });

  it('ignores an event for a DIFFERENT producer', async () => {
    const p = proc();
    await p.loadArtifacts();

    p.applyArtifactEvent(
      event('artifact.created', ID_A, { name: 'someone-elses.md', generated_by: OTHER_TYPEID }),
    );

    expect(p.artifacts).toEqual([]);
  });
});

describe('AgenticProcess.artifacts — the subscribe-before-fetch gap', () => {
  let callActionSpy: ReturnType<typeof spyCallAction>;

  beforeEach(() => {
    callActionSpy = spyCallAction();
  });
  afterEach(() => {
    callActionSpy.mockRestore();
  });

  /** A GET the test resolves by hand, so an event can land mid-flight. */
  const deferredGet = (payload: unknown) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    callActionSpy.mockImplementation((async () => {
      await gate;
      return payload;
    }) as never);
    return release;
  };

  it('keeps an event that landed while the GET was in flight', async () => {
    const p = proc();
    const release = deferredGet({ artifacts: [row(ID_A, 'a.md')] });
    const loading = p.loadArtifacts();

    // The row the snapshot predates — it exists only because of this event.
    p.applyArtifactEvent(event('artifact.created', ID_B, { name: 'b.md' }));
    release();
    await loading;

    expect(names(p).sort()).toEqual(['a.md', 'b.md']);
  });

  it('does not let a STALE snapshot clobber an update already applied', async () => {
    const p = proc();
    const release = deferredGet({ artifacts: [row(ID_A, 'old-name.md')] });
    const loading = p.loadArtifacts();

    p.applyArtifactEvent(event('artifact.updated', ID_A, { name: 'new-name.md' }));
    release();
    await loading;

    expect(names(p)).toEqual(['new-name.md']);
  });

  it('does not resurrect a row deleted while the GET was in flight', async () => {
    const p = proc();
    const release = deferredGet({ artifacts: [row(ID_A, 'a.md'), row(ID_B, 'b.md')] });
    const loading = p.loadArtifacts();

    p.applyArtifactEvent(event('artifact.deleted', ID_A));
    release();
    await loading;

    expect(names(p)).toEqual(['b.md']);
  });
});
