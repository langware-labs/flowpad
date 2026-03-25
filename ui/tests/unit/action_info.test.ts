import { describe, it, expect } from 'vitest';
import { ActionInfo, TypeId } from '@sdk';

// Sample UUIDv4s for testing
const WORKSPACE_ID = '123e4567-e89b-4456-8abc-def123456789';

describe('ActionInfo', () => {
  it('actionUrl', () => {
    const actionInfo = new ActionInfo('sync', 'task');
    actionInfo.scope = [new TypeId('workspace', WORKSPACE_ID)];
    expect(actionInfo.actionUrl).toBe(`/graph/workspace/${WORKSPACE_ID}/task/sync`);
  });
});
