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
    });

    expect(process.project_id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('round-trips a headless process source pin without changing its model or public access', () => {
    const pin = {
      llm_endpoint_typeid: 'llm_endpoint-11111111-1111-4111-8111-111111111111',
      llm_endpoint_public: true,
      llm_endpoint_tiers: { sm: 'test/model-small' },
    };
    const process = AgenticProcess.newHeadless({ ...pin, worker_type: 'codex', cli_config: { model: 'test/model-small' } });
    const serialized = JSON.parse(JSON.stringify(process.toJSON()));
    expect(serialized).toMatchObject({ ...pin, pty_mode: false, cli_config: { model: 'test/model-small' } });
    expect(new AgenticProcess(serialized).llm_endpoint_typeid).toBe(pin.llm_endpoint_typeid);
  });
});
