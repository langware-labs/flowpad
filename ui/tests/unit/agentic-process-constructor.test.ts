import { AgenticProcess, dataManager } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('AgenticProcess constructor', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });

  afterEach(async () => {
    await dataManager.clearCache();
  });

  it('preserves project metadata from constructor data', () => {
    const process = new AgenticProcess({
      id: '00000000-0000-4000-8000-000000000001',
      project_id: '11111111-1111-4111-8111-111111111111',
      project_encoded_name: '-Users-shlom-project',
    });

    expect(process.project_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(process.project_encoded_name).toBe('-Users-shlom-project');
  });
});
