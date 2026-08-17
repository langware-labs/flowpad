/**
 * The client half of the Artifact consolidation contract.
 *
 * An Artifact REFERENCES an asset (`asset_ref`) and records WHO produced it
 * (`generated_by`, a TypeId string like `agentic_process-<uuid>`). Both are new
 * wire fields, and `Artifact` overrides `toJSON()` with an explicit key
 * deny-list plus explicit re-adds — so a field that parses fine can still be
 * silently dropped on the way back out. That round-trip is what these pin.
 *
 * `generating_flow_id` was RETIRED, not renamed. If it ever aliases into
 * `generated_by`, dropped provenance quietly resurrects with the wrong
 * semantics; the last test forbids it.
 */
import { describe, expect, it } from 'vitest';
import { Artifact } from '@sdk';

const PROC_TYPEID = 'agentic_process-1f8c9d2e-0000-4000-8000-000000000042';
const ASSET_PATH = '/repo/docs/report.md';

describe('Artifact wire shape', () => {
  it('parses generated_by and asset_ref off the wire', () => {
    const a = new Artifact({
      name: 'report.md',
      kind: 'content.file',
      generated_by: PROC_TYPEID,
      asset_ref: ASSET_PATH,
    } as never);

    expect(a.generated_by).toBe(PROC_TYPEID);
    expect(a.asset_ref).toBe(ASSET_PATH);
  });

  it('defaults generated_by to null — provenance is never invented', () => {
    const a = new Artifact({ name: 'orphan', kind: 'content.file' });

    expect(a.generated_by).toBeNull();
    expect(a.asset_ref).toBe('');
  });

  it('survives toJSON — the override re-adds every canonical field', () => {
    const a = new Artifact({
      name: 'report.md',
      kind: 'content.file',
      generated_by: PROC_TYPEID,
      asset_ref: ASSET_PATH,
    } as never);

    const json = a.toJSON();

    expect(json.generated_by).toBe(PROC_TYPEID);
    expect(json.asset_ref).toBe(ASSET_PATH);
  });

  it('round-trips through toJSON into an equivalent instance', () => {
    const a = new Artifact({
      name: 'report.md',
      kind: 'content.file',
      generated_by: PROC_TYPEID,
      asset_ref: ASSET_PATH,
    } as never);

    const b = new Artifact(a.toJSON());

    expect(b.generated_by).toBe(PROC_TYPEID);
    expect(b.asset_ref).toBe(ASSET_PATH);
  });

  it('references an asset that is NOT the artifact itself', () => {
    const a = new Artifact({
      name: 'report.md',
      kind: 'content.file',
      asset_ref: ASSET_PATH,
    } as never);

    expect(a.asset_ref).not.toBe(`${Artifact.type}-${a.id}`);
    expect(a.asset_ref).not.toContain(a.id);
  });

  it('does not resurrect the retired generating_flow_id as generated_by', () => {
    const a = new Artifact({
      name: 'legacy',
      kind: 'content.file',
      generating_flow_id: PROC_TYPEID,
    } as never);

    expect(a.generated_by).toBeNull();
    expect((a as unknown as Record<string, unknown>).generating_flow_id).toBeUndefined();
    expect(a.toJSON().generating_flow_id).toBeUndefined();
  });

  it('still normalizes legacy kinds', () => {
    const a = new Artifact({ name: 'app', artifact_type: 'WEBAPP' } as never);

    expect(a.kind).toBe('application.web');
  });
});
