import { describe, expect, it, vi } from 'vitest';
import { claimAskRun, deliverClaimedQuestion } from '@src/components/ask/ask-claims';

describe('ask claims — a screen showing a wizard run draws its questions in place', () => {
  it('hands a question to whoever claimed its run, and nobody else', () => {
    const handler = vi.fn();
    const release = claimAskRun('wizard-wa-1-data_source_a', handler);
    expect(deliverClaimedQuestion('wizard-wa-1-data_source_a', 'q1')).toBe(true);
    expect(handler).toHaveBeenCalledWith('q1');
    expect(deliverClaimedQuestion('wizard-wa-1-data_source_b', 'q2')).toBe(false);
    expect(deliverClaimedQuestion(undefined, 'q3')).toBe(false);
    release();
    expect(deliverClaimedQuestion('wizard-wa-1-data_source_a', 'q4')).toBe(false);
  });

  it('a stale release does not drop a newer claim of the same run', () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = claimAskRun('run', first);
    const releaseSecond = claimAskRun('run', second);
    releaseFirst();
    expect(deliverClaimedQuestion('run', 'q')).toBe(true);
    expect(second).toHaveBeenCalledWith('q');
    expect(first).not.toHaveBeenCalled();
    releaseSecond();
  });
});
