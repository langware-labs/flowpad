/**
 * Minimal failing test for the sniffer event line misalignment bug.
 *
 * Root cause: bucketEventToAbsRow() always uses segments[segments.length - 1],
 * meaning sniffer events with timestamps from earlier segments get bucketed
 * to the wrong (last) segment's row range.
 */

import { describe, it, expect } from 'vitest';
import { PtySegment, bucketEventToAbsRow } from '@sdk/pty-sync/PtySegment.js';

describe('bucketEventToAbsRow — multi-segment Phase-2 alignment', () => {
  /**
   * Scenario: Phase-2 segments built from annotations (buildSegmentsFromAnchors).
   *
   * Two prompt-anchored segments:
   *   Segment 0: baseAbsRow=0,  rows=10, T0 → T1  (user typed "hi" at T0)
   *   Segment 1: baseAbsRow=10, rows=10, T1 → T2  (user typed second prompt at T1)
   *
   * A sniffer UserPromptSubmit event arrives at T0+1ms (belongs to segment 0).
   * After buildSegmentsFromAnchors creates both segments, bucketEventToAbsRow
   * should map T0+1 to a row in segment 0 (rows 0–9).
   *
   * BUG: bucketEventToAbsRow always uses segments[segments.length - 1] (segment 1),
   * so T0+1ms is bucketed into segment 1 (rows 10-19) — wrong segment, wrong line.
   */

  it('early-timestamp event is mapped to the correct first segment (not the last)', () => {
    const T0 = 1_000_000; // ms — start of first prompt segment
    const T1 = 1_010_000; // start of second prompt segment (10s later)
    const T2 = 1_020_000; // end of second segment

    // Phase-2 segments as buildSegmentsFromAnchors creates them
    const seg0 = new PtySegment(T0, 10, 0);   // rows 0-9, T0 → T1
    seg0.endTime = T1;
    seg0.finalized = true;

    const seg1 = new PtySegment(T1, 10, 10);  // rows 10-19, T1 → T2
    seg1.endTime = T2;
    seg1.finalized = true;

    const segments = [seg0, seg1];

    // Sniffer UserPromptSubmit event at T0+1ms (start of first prompt — belongs to segment 0)
    const snifferEventTs = T0 + 1;

    const absRow = bucketEventToAbsRow(snifferEventTs, segments);

    // The event belongs to segment 0 (T0 ≤ ts < T1), so absRow must be in [0, 9].
    expect(absRow).toBeGreaterThanOrEqual(0);
    expect(absRow).toBeLessThanOrEqual(9);
  });

  it('correctly buckets an event within the last segment (single-segment, no regression)', () => {
    const T0 = 1_000_000;
    const T1 = 1_010_000;

    const seg0 = new PtySegment(T0, 10, 0);
    seg0.endTime = T1;
    seg0.finalized = true;

    const segments = [seg0];

    // Event in the middle of the only segment
    const ts = T0 + 5_000; // midpoint → row 5
    const absRow = bucketEventToAbsRow(ts, segments);
    expect(absRow).toBe(5); // row 5 of 10-row segment starting at row 0
  });
});
