import { describe, it, expect } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { buildDockUrl, parseDockUrl } from '@src/navigation/url-builder';
import { TypeId, ViewType } from '@sdk';

describe('DockPointer plan pointer round-trip', () => {
  it('forPlan (typeid form) → parsePlanPointer preserves the PLAN typeId', () => {
    const planTypeId = new TypeId('plan', '7542cf25-ef88-51c1-8fc5-09e60be2d85b');
    const dp = DockPointer.forPlan(planTypeId);
    const parsed = DockPointer.parsePlanPointer(dp.pointer!);

    expect(parsed?.kind).toBe('typeid');
    expect(parsed?.kind === 'typeid' && parsed.planTypeId.toString()).toBe(planTypeId.toString());
  });

  it('forPlanByPath (vfs form) → parsePlanPointer preserves the absolute machine path', () => {
    const filePath = '/Users/alice/.claude/plans/refactor-auth.md';
    const dp = DockPointer.forPlanByPath(filePath);
    const parsed = DockPointer.parsePlanPointer(dp.pointer!);

    expect(parsed?.kind).toBe('vfs');
    // The vfs value is "compute_node-@local/Users/.../refactor-auth.md" — never null.
    expect(parsed?.kind === 'vfs' && parsed.vfsValue).toContain('compute_node-@local');
  });

  it('legacy agentic_process pointer parses to the legacy shape (for loader redirect)', () => {
    const parsed = DockPointer.parsePlanPointer('agentic_process-abc-123/home/user/plans/x.md');
    expect(parsed?.kind).toBe('legacy');
    expect(parsed?.kind === 'legacy' && parsed.agenticProcessTypeId.toString()).toBe('agentic_process-abc-123');
    expect(parsed?.kind === 'legacy' && parsed.filePath).toBe('/home/user/plans/x.md');
  });

  it('parsePlanPointer returns null for an unknown method', () => {
    expect(DockPointer.parsePlanPointer('shell-abc/foo')).toBeNull();
  });

  it('parsePlanPointer returns null for a pointer without a value', () => {
    expect(DockPointer.parsePlanPointer('typeid')).toBeNull();
    expect(DockPointer.parsePlanPointer('vfs')).toBeNull();
  });

  // Regression: the old grammar concatenated "<typeid>/<absoluteFilePath>",
  // producing an embedded "//" that react-router normalized away — silently
  // demoting the absolute path to a relative one. The explicit method segment
  // (typeid|vfs) makes the path un-mistakable; assert no "//" survives.
  it('vfs form survives a full buildDockUrl → parseDockUrl round-trip with no "//"', () => {
    const filePath = '/Users/alice/.claude/plans/we-would-like-the-snoopy-dijkstra.md';
    const dp = DockPointer.forPlanByPath(filePath);
    const url = buildDockUrl('/', ViewType.PLAN, dp.pointer);

    expect(url.replace(/^\//, '').includes('//')).toBe(false);

    const parsedUrl = parseDockUrl(url);
    expect(parsedUrl).not.toBeNull();
    expect(parsedUrl!.viewType).toBe(ViewType.PLAN);

    const parsed = DockPointer.parsePlanPointer(decodeURIComponent(parsedUrl!.pointer!));
    expect(parsed?.kind).toBe('vfs');
  });

  it('typeid form is the tab target; vfs form is path-resolved (null target)', () => {
    const planTypeId = new TypeId('plan', '7542cf25-ef88-51c1-8fc5-09e60be2d85b');
    expect(DockPointer.forPlan(planTypeId).targetTypeId?.toString()).toBe(planTypeId.toString());
    expect(DockPointer.forPlanByPath('/Users/alice/.claude/plans/x.md').targetTypeId).toBeNull();
  });
});
