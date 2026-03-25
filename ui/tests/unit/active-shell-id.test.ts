/**
 * FLOWPAD-1645: dataContext.activeShellId consolidation.
 *
 * Tests that dataContext.setActiveShellId properly updates the value
 * and emits CONTEXT_CHANGED so useContext() subscribers get notified.
 * This replaced the separate Zustand useTerminalStateStore.
 */

import { describe, expect, it, vi } from 'vitest';
import { ContextEventType, dataContext } from '@sdk';

describe('dataContext.activeShellId', () => {
  it('defaults to empty string', () => {
    expect(dataContext.activeShellId).toBe('');
  });

  it('setActiveShellId updates the value', () => {
    dataContext.setActiveShellId('shell-123');
    expect(dataContext.activeShellId).toBe('shell-123');

    // Restore default
    dataContext.setActiveShellId('');
  });

  it('setActiveShellId emits CONTEXT_CHANGED', () => {
    const listener = vi.fn();
    dataContext.on(ContextEventType.CONTEXT_CHANGED, listener);

    dataContext.setActiveShellId('shell-456');
    expect(listener).toHaveBeenCalledTimes(1);

    // Restore and cleanup
    dataContext.setActiveShellId('');
    dataContext.off(ContextEventType.CONTEXT_CHANGED, listener);
  });

  it('setActiveShellId does not emit when value is unchanged', () => {
    dataContext.setActiveShellId('shell-789');
    const listener = vi.fn();
    dataContext.on(ContextEventType.CONTEXT_CHANGED, listener);

    // Set same value again
    dataContext.setActiveShellId('shell-789');
    expect(listener).not.toHaveBeenCalled();

    // Restore and cleanup
    dataContext.off(ContextEventType.CONTEXT_CHANGED, listener);
    dataContext.setActiveShellId('');
  });
});
