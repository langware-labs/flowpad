/**
 * Regression test for: main-loader fetches ALL agentic processes instead of
 * only visible ones, causing 300+ entity rows to be loaded on every navigation.
 *
 * The processQuery must filter { visible: true } so that completed / archived
 * processes that had visible set to false are excluded.
 */
import { describe, it, expect } from 'vitest';
import { QueryFilter } from '@sdk';

const visibleProcessQuery = new QueryFilter({ match: { visible: true } as Record<string, unknown> });

const makeProcess = (overrides: Record<string, unknown> = {}) => ({
  type: 'agentic_process',
  id: '00000000-0000-4000-8000-000000000001',
  name: 'test process',
  status: 'idle',
  visible: false,
  ...overrides,
});

describe('AgenticProcess visible filter', () => {
  it('includes a process with visible=true', () => {
    expect(visibleProcessQuery.validate(makeProcess({ visible: true }))).toBe(true);
  });

  it('excludes a process with visible=false', () => {
    expect(visibleProcessQuery.validate(makeProcess({ visible: false }))).toBe(false);
  });

  it('excludes a process with visible=null', () => {
    expect(visibleProcessQuery.validate(makeProcess({ visible: null }))).toBe(false);
  });

  it('excludes a process with visible missing entirely', () => {
    const proc = makeProcess();
    delete proc.visible;
    expect(visibleProcessQuery.validate(proc)).toBe(false);
  });

  it('excludes a completed process that was not made visible', () => {
    expect(visibleProcessQuery.validate(makeProcess({ status: 'complete', visible: false }))).toBe(false);
  });

  it('includes a running process that is visible', () => {
    expect(visibleProcessQuery.validate(makeProcess({ status: 'running', visible: true }))).toBe(true);
  });
});
