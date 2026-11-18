import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, llmEndpointsService, LLMEndpoint } from '@sdk';

afterEach(() => vi.restoreAllMocks());

describe('endpoint model configuration SDK contract', () => {
  it('preserves an HTTP authorization failure instead of inventing a default', async () => {
    const error = Object.assign(new Error('Model configuration denied'), { response: { status: 403 } });
    vi.spyOn(dataManager, 'callAction').mockRejectedValueOnce(error);
    await expect(llmEndpointsService.getModelConfig('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toBe(error);
  });

  it('reads the narrow backend result through the hub-reflected SDK action unchanged', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const result = {
      endpoint_typeid: `llm_endpoint-${id}`,
      tiers: { sm: 'provider/small' },
      default_model: null,
      effective_default_model: 'provider/small',
    };
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue(result);
    expect(await llmEndpointsService.getModelConfig(id)).toBe(result);
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0][0]).toMatchObject({ name: 'model-config', hubReflect: true });
  });

  it('retains null/unavailable separately from omitted older-server resolution', () => {
    const old = new LLMEndpoint({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(old.default_model).toBeNull();
    expect(old.effective_default_model).toBeUndefined();
    const current = new LLMEndpoint({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      default_model: 'lg',
      effective_default_model: null,
    });
    expect(current.default_model).toBe('lg');
    expect(current.effective_default_model).toBeNull();
  });
});
