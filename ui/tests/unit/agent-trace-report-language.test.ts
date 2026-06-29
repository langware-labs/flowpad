import { describe, expect, it } from 'vitest';
import {
  flattenIssues,
  friendlyKind,
  friendlySeverity,
  friendlyVerdict,
  pluralize,
  skillsInvolved,
} from '@src/components/assets/editor/agent-trace/simple/report-language';
import type { AgentTraceDoc, TraceFinding } from '@src/components/assets/editor/agent-trace/trace-types';

/** Minimal trace doc — only the shape the report language reads. */
function trace(
  annotations: {
    by_skill?: Record<string, { skill: string; findings: TraceFinding[] }>;
    unattributed?: TraceFinding[];
    divergences?: { label: string; detail?: string; severity?: string }[];
    issues?: { label: string; detail?: string; severity?: string }[];
  },
  markers?: { kind: string; severity?: string; label: string; detail?: string }[],
): AgentTraceDoc {
  return { annotations, markers } as unknown as AgentTraceDoc;
}

function finding(over: Partial<TraceFinding> = {}): TraceFinding {
  return { kind: 'issue', label: 'something', ...over };
}

describe('friendlyVerdict', () => {
  it('maps ok/mixed/bad to distinct tones and carries the reason', () => {
    expect(friendlyVerdict('ok', 'all done').tone).toBe('ok');
    expect(friendlyVerdict('mixed').tone).toBe('mixed');
    expect(friendlyVerdict('bad').tone).toBe('bad');
    expect(friendlyVerdict('ok', 'all done').reason).toBe('all done');
  });

  it('treats unknown / missing / unrated as neutral with no reason', () => {
    expect(friendlyVerdict(null).tone).toBe('neutral');
    expect(friendlyVerdict('unrated').tone).toBe('neutral');
    expect(friendlyVerdict('ok', null).reason).toBe('');
  });
});

describe('friendlySeverity', () => {
  it('translates severities to plain chips', () => {
    expect(friendlySeverity('attention')).toEqual({ label: 'Needs a look', tone: 'bad' });
    expect(friendlySeverity('warning')).toEqual({ label: 'Minor', tone: 'mixed' });
    expect(friendlySeverity(undefined)).toEqual({ label: 'Note', tone: 'neutral' });
  });
});

describe('friendlyKind', () => {
  it('translates divergence and issue to everyday words', () => {
    expect(friendlyKind('divergence')).toBe("Didn't follow its instructions");
    expect(friendlyKind('issue')).toBe('Problem');
    expect(friendlyKind('mystery')).toBe('Note');
  });
});

describe('flattenIssues', () => {
  it('prefers curated per-skill findings (tagged) + unattributed (untagged)', () => {
    const doc = trace({
      by_skill: {
        a: { skill: 'skill-a', findings: [finding({ label: 'a1' }), finding({ label: 'a2' })] },
        b: { skill: 'skill-b', findings: [finding({ label: 'b1', kind: 'divergence' })] },
      },
      unattributed: [finding({ label: 'general thing' })],
    });
    const out = flattenIssues(doc);
    expect(out).toHaveLength(4);
    expect(out.filter((i) => i.skillName === 'skill-a')).toHaveLength(2);
    expect(out.find((i) => i.title === 'b1')?.kind).toBe('divergence');
    expect(out.find((i) => i.title === 'general thing')?.skillName).toBeUndefined();
  });

  it('falls back to markers when no curated buckets exist, and collapses repeats with a count', () => {
    const doc = trace(
      { divergences: [{ label: 'curated only' }] }, // curated path empty (no by_skill/unattributed)
      [
        { kind: 'issue', severity: 'attention', label: 'Edit failed' },
        { kind: 'issue', severity: 'attention', label: 'Edit failed' },
        { kind: 'divergence', severity: 'attention', label: 'Went off-script' },
        { kind: 'plan', label: 'ignored non-issue marker' },
      ],
    );
    const out = flattenIssues(doc);
    // markers win over the legacy divergences list; non-issue markers dropped
    expect(out).toHaveLength(2);
    const edit = out.find((i) => i.title === 'Edit failed');
    expect(edit?.count).toBe(2);
    expect(out.some((i) => i.title === 'curated only')).toBe(false);
  });

  it('falls back to annotation divergences/issues when there are no markers', () => {
    const doc = trace({
      divergences: [{ label: 'd1' }],
      issues: [{ label: 'i1' }, { label: 'i2' }],
    });
    const out = flattenIssues(doc);
    expect(out.map((i) => i.kind).sort()).toEqual(['divergence', 'issue', 'issue']);
    expect(out.every((i) => i.count === 1)).toBe(true);
  });

  it('returns [] for a null doc', () => {
    expect(flattenIssues(null)).toEqual([]);
  });
});

describe('skillsInvolved', () => {
  it('counts findings per skill, keeps zero-finding skills, sorts most-problems first', () => {
    const doc = trace({
      by_skill: {
        clean: { skill: 'clean', findings: [] },
        busy: { skill: 'busy', findings: [finding(), finding(), finding()] },
        one: { skill: 'one', findings: [finding()] },
      },
    });
    const out = skillsInvolved(doc);
    expect(out.map((s) => s.name)).toEqual(['busy', 'one', 'clean']);
    expect(out.map((s) => s.issueCount)).toEqual([3, 1, 0]);
  });
});

describe('pluralize', () => {
  it('singularizes only at 1', () => {
    expect(pluralize(1, 'problem')).toBe('1 problem');
    expect(pluralize(0, 'problem')).toBe('0 problems');
    expect(pluralize(3, 'problem')).toBe('3 problems');
  });
});
