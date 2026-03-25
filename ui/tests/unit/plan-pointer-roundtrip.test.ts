import { describe, it, expect } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { TypeId } from '@sdk';

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
});
