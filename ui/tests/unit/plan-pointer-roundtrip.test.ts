import { describe, it, expect } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { buildDockUrl, parseDockUrl } from '@src/navigation/url-builder';
import { TypeId, ViewType } from '@sdk';

describe('DockPointer plan pointer round-trip', () => {
  const processTypeId = new TypeId('agentic_process', 'abc-123');

  it('forPlan → parsePlanPointer preserves absolute filePath', () => {
    const filePath = '/home/user/plans/my-plan.md';
    const dp = DockPointer.forPlan(processTypeId, filePath);
    const parsed = DockPointer.parsePlanPointer(dp.pointer!);

    expect(parsed).not.toBeNull();
    expect(parsed!.agenticProcessTypeId.toString()).toBe(processTypeId.toString());
    // The file path must match exactly — no double-slash
    expect(parsed!.filePath).toBe(filePath);
  });

  it('forPlan → parsePlanPointer preserves deeply nested absolute path', () => {
    const filePath = '/home/user/projects/app/plans/refactor-auth.md';
    const dp = DockPointer.forPlan(processTypeId, filePath);
    const parsed = DockPointer.parsePlanPointer(dp.pointer!);

    expect(parsed).not.toBeNull();
    expect(parsed!.filePath).toBe(filePath);
  });

  it('parsePlanPointer returns null for non-agentic-process pointer', () => {
    expect(DockPointer.parsePlanPointer('shell-abc/foo')).toBeNull();
  });

  it('parsePlanPointer returns null for pointer without slash', () => {
    expect(DockPointer.parsePlanPointer('agentic_process-abc')).toBeNull();
  });

  // Regression: forPlan used to concat "<typeid>/<absoluteFilePath>" producing
  // an embedded "//", which react-router normalized away — silently demoting
  // the absolute path to a relative one after a URL round-trip.
  it('survives full buildDockUrl → parseDockUrl round-trip for absolute path', () => {
    const filePath = '/Users/alice/.claude/plans/we-would-like-the-snoopy-dijkstra.md';
    const dp = DockPointer.forPlan(processTypeId, filePath);
    const url = buildDockUrl('/', ViewType.PLAN, dp.pointer);

    // URL must not contain an embedded "//" after "/dock/"
    expect(url.replace(/^\//, '').includes('//')).toBe(false);

    const parsedUrl = parseDockUrl(url);
    expect(parsedUrl).not.toBeNull();
    expect(parsedUrl!.viewType).toBe(ViewType.PLAN);

    const parsed = DockPointer.parsePlanPointer(decodeURIComponent(parsedUrl!.pointer!));
    expect(parsed).not.toBeNull();
    expect(parsed!.filePath).toBe(filePath);
  });
});
