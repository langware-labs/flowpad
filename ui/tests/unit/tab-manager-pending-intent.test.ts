/**
 * TabManager pending-intent slot — set / peek / consume-once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tabManager } from '@sdk';

afterEach(() => tabManager.resetForTests());

describe('pending-intent slot', () => {
  it('starts empty', () => {
    expect(tabManager.peekPendingIntent()).toBeNull();
  });

  it('set then peek returns the value without clearing', () => {
    tabManager.setPendingIntent('agentic_process-1');
    expect(tabManager.peekPendingIntent()).toBe('agentic_process-1');
    expect(tabManager.peekPendingIntent()).toBe('agentic_process-1');
  });

  it('consume clears it (consume-once)', () => {
    tabManager.setPendingIntent('shell-9');
    tabManager.consumePendingIntent();
    expect(tabManager.peekPendingIntent()).toBeNull();
  });

  it('setPendingIntent(null) clears', () => {
    tabManager.setPendingIntent('x');
    tabManager.setPendingIntent(null);
    expect(tabManager.peekPendingIntent()).toBeNull();
  });
});
