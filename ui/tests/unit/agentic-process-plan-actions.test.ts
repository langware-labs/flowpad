import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { AgenticProcess, dataManager, ActionInfo } from '@sdk';

/**
 * Unit tests for AgenticProcess.executePlan() and updatePlan() parameter passing.
 *
 * Verifies that file_path is sent as a required body parameter to the backend.
 */

describe('AgenticProcess.executePlan', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    callActionSpy.mockRestore();
  });

  it('sends file_path in body parameters', async () => {
    const process = new AgenticProcess({ id: 'test-123', state: { status: 'running' } });

    await process.executePlan('/plans/my-plan.md');

    expect(callActionSpy).toHaveBeenCalledOnce();
    const actionInfo: ActionInfo = callActionSpy.mock.calls[0][0] as ActionInfo;
    expect(actionInfo.bodyParameters).toMatchObject({
      file_path: '/plans/my-plan.md',
    });
  });

  it('sends file_path and clear_context=true in body parameters', async () => {
    const process = new AgenticProcess({ id: 'test-123', state: { status: 'running' } });

    await process.executePlan('/plans/my-plan.md', { clearContext: true });

    expect(callActionSpy).toHaveBeenCalledOnce();
    const actionInfo: ActionInfo = callActionSpy.mock.calls[0][0] as ActionInfo;
    expect(actionInfo.bodyParameters).toMatchObject({
      file_path: '/plans/my-plan.md',
      clear_context: true,
    });
  });

  it('sends clear_context=false when specified', async () => {
    const process = new AgenticProcess({ id: 'test-123', state: { status: 'running' } });

    await process.executePlan('/plans/my-plan.md', { clearContext: false });

    expect(callActionSpy).toHaveBeenCalledOnce();
    const actionInfo: ActionInfo = callActionSpy.mock.calls[0][0] as ActionInfo;
    expect(actionInfo.bodyParameters).toMatchObject({
      file_path: '/plans/my-plan.md',
      clear_context: false,
    });
  });

  it('uses execute-plan action name', async () => {
    const process = new AgenticProcess({ id: 'test-123', state: { status: 'running' } });

    await process.executePlan('/plans/my-plan.md');

    const actionInfo: ActionInfo = callActionSpy.mock.calls[0][0] as ActionInfo;
    expect(actionInfo.name).toBe('execute-plan');
  });
});

describe('AgenticProcess.updatePlan', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    callActionSpy.mockRestore();
  });

  it('sends file_path in body parameters', async () => {
    const process = new AgenticProcess({ id: 'test-456', state: { status: 'running' } });

    await process.updatePlan('/plans/update-me.md');

    expect(callActionSpy).toHaveBeenCalledOnce();
    const actionInfo: ActionInfo = callActionSpy.mock.calls[0][0] as ActionInfo;
    expect(actionInfo.bodyParameters).toMatchObject({
      file_path: '/plans/update-me.md',
    });
  });

  it('uses update-plan action name', async () => {
    const process = new AgenticProcess({ id: 'test-456', state: { status: 'running' } });

    await process.updatePlan('/plans/update-me.md');

    const actionInfo: ActionInfo = callActionSpy.mock.calls[0][0] as ActionInfo;
    expect(actionInfo.name).toBe('update-plan');
  });
});
