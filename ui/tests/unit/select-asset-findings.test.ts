import { describe, expect, it } from 'vitest';
import { selectAssetFindings } from '@src/components/assets/editor/skill/skill-eval-analysis';
import type { AgentTraceDoc, TraceFinding } from '@src/components/assets/editor/agent-trace/trace-types';

const KEY = 'agent-b37c@/records/exec/assets/.claude/agents/vibe.md';
const TYPEID = 'agent-b37c';
const PATH = '/records/exec/assets/.claude/agents/vibe.md';
const SEL = { assetKey: KEY, assetTypeid: TYPEID, assetPath: PATH };

const finding = (label: string): TraceFinding => ({ kind: 'issue', label } as TraceFinding);

function trace(annotations: Record<string, unknown>): AgentTraceDoc {
  return { annotations } as unknown as AgentTraceDoc;
}

describe('selectAssetFindings', () => {
  it('reads by_asset by the launch key first', () => {
    const doc = trace({ by_asset: { [KEY]: { findings: [finding('a')] } } });
    expect(selectAssetFindings(doc, SEL).map((f) => f.label)).toEqual(['a']);
  });

  it('rescues a mis-keyed bucket via its asset_ref / typeid fields', () => {
    expect(
      selectAssetFindings(trace({ by_asset: { other: { asset_ref: PATH, findings: [finding('r')] } } }), SEL)[0].label,
    ).toBe('r');
    expect(
      selectAssetFindings(trace({ by_asset: { other: { typeid: TYPEID, findings: [finding('t')] } } }), SEL)[0].label,
    ).toBe('t');
  });

  it('falls back to by_skill keyed by the main-file stem ONLY when the trace has no by_asset (pre-by_asset traces)', () => {
    const legacy = trace({ by_skill: { vibe: { skill: 'vibe', findings: [finding('s')] } } });
    expect(selectAssetFindings(legacy, SEL).map((f) => f.label)).toEqual(['s']);
    // A present-but-empty by_asset is a real "analyzer found nothing" signal —
    // it must NOT fabricate a match via the stem heuristic.
    const empty = trace({
      by_asset: { [KEY]: { findings: [] } },
      by_skill: { vibe: { skill: 'vibe', findings: [finding('s')] } },
    });
    expect(selectAssetFindings(empty, SEL)).toEqual([]);
  });

  it('returns empty for no doc / no matching bucket / unrelated by_skill', () => {
    expect(selectAssetFindings(null, SEL)).toEqual([]);
    expect(selectAssetFindings(trace({}), SEL)).toEqual([]);
    expect(selectAssetFindings(trace({ by_skill: { other: { skill: 'other', findings: [finding('x')] } } }), SEL)).toEqual([]);
  });
});
