/**
 * Phase-1: the pending-intent slot — set / peek / consume-once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  consumePendingIntent,
  peekPendingIntent,
  setPendingIntent,
} from '@src/tabs/pending-intent';

afterEach(() => setPendingIntent(null));

describe('pending-intent slot', () => {
  it('starts empty', () => {
    expect(peekPendingIntent()).toBeNull();
  });

  it('set then peek returns the value without clearing', () => {
    setPendingIntent('agentic_process-1');
    expect(peekPendingIntent()).toBe('agentic_process-1');
    expect(peekPendingIntent()).toBe('agentic_process-1');
  });

  it('consume clears it (consume-once)', () => {
    setPendingIntent('shell-9');
    consumePendingIntent();
    expect(peekPendingIntent()).toBeNull();
  });

  it('setPendingIntent(null) clears', () => {
    setPendingIntent('x');
    setPendingIntent(null);
    expect(peekPendingIntent()).toBeNull();
  });
});
