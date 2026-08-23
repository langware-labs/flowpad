/**
 * `session_meta` does two unrelated jobs in the transcript lens, and collapsing
 * them breaks one or the other.
 *
 *  - It is the SESSION ENVELOPE: header material for every vendor, never a
 *    conversation row. Always filtered out of the entry list.
 *  - It is ALSO what the workflow-run summary strip keys on — but that strip
 *    reads workflow-only payload fields, so rendering it over a worker
 *    transcript yields four tiles reading 0.
 *
 * Gating the envelope lookup itself on `workerType === 'workflow'` fixes the
 * fabricated header and simultaneously stops the filtering, so codex/copilot/
 * opencode gain a spurious trace row. That regression escaped every unit test
 * and was caught only by a Playwright count assertion (12 expected, 13 rendered).
 * These tests encode the two-job split so the next person cannot re-collapse it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE = readFileSync(
  path.resolve(
    __dirname,
    '../../src/components/lens-viewer/shared/transcript-features/TranscriptViewer.tsx',
  ),
  'utf8',
);

describe('TranscriptViewer session-envelope handling', () => {
  it('derives the envelope WITHOUT consulting the worker', () => {
    // The lookup itself must be vendor-agnostic; only the summary strip is gated.
    const decl = SOURCE.slice(SOURCE.indexOf('const sessionEnvelope'));
    const body = decl.slice(0, decl.indexOf('  );') + 4);
    expect(body).toContain("subtype === 'session_meta'");
    expect(body, 'the envelope lookup must not be gated on workerType').not.toContain('workerType');
  });

  it('filters the envelope out of the rows, not the workflow-strip value', () => {
    // `entry === workflowMeta` was the old filter; it is null for every
    // non-workflow vendor, so the envelope leaked into the row list.
    expect(SOURCE).toContain('if (entry === sessionEnvelope) return false;');
    expect(SOURCE).not.toContain('if (entry === workflowMeta) return false;');
  });

  it('gates only the summary strip on the worker', () => {
    expect(SOURCE).toContain("const workflowMeta = workerType === 'workflow' ? sessionEnvelope : null;");
  });

  it('keeps the row filter memo keyed on the envelope', () => {
    // A stale dep here would freeze the filter across transcripts.
    const memoDeps = SOURCE.slice(SOURCE.indexOf('const filteredEntries'));
    const depLine = memoDeps.slice(0, memoDeps.indexOf('\n\n'));
    expect(depLine).toContain('sessionEnvelope');
  });
});
